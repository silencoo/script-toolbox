using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace SunshineDisplay
{
    internal sealed class TrayContext : ApplicationContext
    {
        readonly NotifyIcon icon=new NotifyIcon();
        readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer();
        readonly string root;
        readonly string boot;
        readonly ToolStripMenuItem stateItem=new ToolStripMenuItem("Checking or Unknown"){Enabled=false};
        Form details; TextBox text;string report="Waiting for monitor";
        internal TrayContext(string monitorRoot) {
            root=Path.GetFullPath(monitorRoot);boot=ConsoleSession.BootKey();
            var menu=new ContextMenuStrip();menu.Items.Add(stateItem);
            menu.Items.Add("Display and recovery details",null,(s,e)=>ShowDetails());
            menu.Items.Add("Open monitor logs",null,(s,e)=>OpenFolder(Path.Combine(root,"data")));
            menu.Items.Add("Open boot recovery logs",null,(s,e)=>OpenFolder(Paths.Data));
            menu.Items.Add(new ToolStripSeparator());menu.Items.Add("Exit tray",null,(s,e)=>ExitThread());
            icon.ContextMenuStrip=menu;icon.Icon=SystemIcons.Question;icon.Text="Sunshine: Checking or Unknown";icon.Visible=true;
            icon.DoubleClick+=(s,e)=>ShowDetails();timer.Interval=2000;timer.Tick+=(s,e)=>Refresh();Refresh();timer.Start();
        }
        static void OpenFolder(string path) {try{if(Directory.Exists(path))Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"explorer.exe"),"\""+path+"\""){UseShellExecute=true});else MessageBox.Show("Log directory is not installed: "+path);}catch(Exception e){MessageBox.Show(e.Message);}}
        void Refresh() {
            var b=new StringBuilder();HealthView view;
            try {
                var data=Json.Read<Dictionary<string,object>>(Path.Combine(root,"data","status.json"));
                view=TrayHealth.Evaluate(data,DateTimeOffset.UtcNow,boot);
                b.AppendLine("DISPLAY / STREAM: "+view.State).AppendLine(view.Detail).AppendLine("Heartbeat age: "+view.AgeSeconds.ToString("0.0")+" seconds");
                b.AppendLine("Observed: "+TrayHealth.Text(data,"At")).AppendLine("Boot: "+TrayHealth.Text(data,"BootKey"));
                foreach(var key in new[]{"ExpectedMonitor","ExpectedPhysicalMonitor","Clients","LogEpoch","Capture","Health","Config","Devices","DisplayTargets","DisplayPaths","Displays","MonitorIdentities","Protection","LastWarnings"}) {
                    b.AppendLine().AppendLine(key+":");Format(b,TrayHealth.Get(data,key),0);
                }
            } catch(Exception e) {view=new HealthView{State="Checking or Unknown",Detail="Cannot read monitor status: "+e.Message};b.AppendLine(view.State).AppendLine(view.Detail).AppendLine("Check SunshineDisplayDiagnosticMonitor task result and local monitor logs.");}
            b.AppendLine().AppendLine("BOOT RECOVERY (separate from current display health):");
            try {
                var r=Json.Read<BootRecord>(Paths.Status);
                if(r.SchemaVersion!=1 || String.IsNullOrWhiteSpace(r.AtUtc)) throw new InvalidDataException("Recovery status schema/timestamp invalid");
                bool current=r.BootKey==BootEpoch.Current(false);
                b.AppendLine(r.Result+" at "+r.AtUtc).AppendLine(r.Detail).AppendLine("Boot: "+r.BootKey+(current?" (current)":" (historical; not current-boot evidence)"));
                if(current && (r.Result=="Fault" || r.Result=="InterruptedRequiresReview")) {
                    b.AppendLine("Recovery needs attention; inspect recovery logs before any manual retry.");
                    if(view.State=="Physical ready") view.State="Fault";
                }
                DateTimeOffset at;
                if((r.Result=="Claimed" || r.Result=="Checking") && (!DateTimeOffset.TryParse(r.AtUtc,out at) || (DateTimeOffset.UtcNow-at).TotalSeconds>15))
                    b.AppendLine("Recovery heartbeat stale: worker may have stopped.");
            } catch(Exception e) {b.AppendLine("Unknown / not installed: "+e.Message);}
            b.AppendLine().AppendLine("Presence means enumerated hardware. Active paths mean Windows desktop attachment. Capture is log/geometry evidence. None proves the panel shows an image.");
            b.AppendLine("Read-only tray. No topology changes, service commands or recovery requests are exposed.");
            b.AppendLine("Monitor logs: "+Path.Combine(root,"data")).AppendLine("Boot logs: "+Paths.Data);
            report=b.ToString();stateItem.Text=view.State;icon.Text="Sunshine: "+view.State;
            icon.Icon=view.State=="Fault"?SystemIcons.Error:view.State=="Privacy streaming"?SystemIcons.Shield:view.State=="Physical ready"?SystemIcons.Information:SystemIcons.Question;
            if(details!=null && !details.IsDisposed && text!=null) {int selection=text.SelectionStart;text.Text=report;text.SelectionStart=Math.Min(selection,text.TextLength);}
        }
        static void Format(StringBuilder b,object value,int depth) {
            string indent=new string(' ',depth*2);
            if(value==null){b.AppendLine(indent+"Unknown / not supplied by this monitor version");return;}
            var dict=value as Dictionary<string,object>;
            if(dict!=null){foreach(var item in dict){b.Append(indent+item.Key+": ");if(item.Value is IDictionary || (item.Value is IEnumerable && !(item.Value is string))){b.AppendLine();Format(b,item.Value,depth+1);}else b.AppendLine(Convert.ToString(item.Value));}return;}
            if(value is IEnumerable && !(value is string)){foreach(object item in (IEnumerable)value){Format(b,item,depth+1);b.AppendLine();}return;}
            b.AppendLine(indent+Convert.ToString(value));
        }
        internal void ShowDetails() {
            if(details!=null && !details.IsDisposed){details.Show();details.Activate();return;}
            details=new Form{Text="Sunshine display and recovery health",Width=900,Height=700,StartPosition=FormStartPosition.CenterScreen};
            text=new TextBox{Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Both,WordWrap=false,Dock=DockStyle.Fill,Font=new Font("Consolas",10),Text=report};
            details.Controls.Add(text);details.Show();
        }
        protected override void ExitThreadCore() {timer.Stop();timer.Dispose();icon.Visible=false;icon.Dispose();if(details!=null)details.Dispose();base.ExitThreadCore();}
    }
    internal static class TrayProgram
    {
        [STAThread] static void Main(string[] args) {
            try {
                bool details=Array.IndexOf(args,"--details")>=0;
                var remaining=new System.Collections.Generic.List<string>(args);remaining.Remove("--details");
                if(remaining.Count!=0 && !(remaining.Count==2 && remaining[0]=="--monitor-root")) throw new ArgumentException("Only --monitor-root <local directory> and --details are supported");
                string root=remaining.Count==2?remaining[1]:Path.Combine(Paths.Data,"monitor");
                if(!Path.IsPathRooted(root) || root.StartsWith(@"\\")) throw new ArgumentException("Monitor status must be a local absolute path");
                bool created;using(var mutex=new Mutex(true,@"Local\SunshineDisplayHealthTray",out created)) {
                    if(!created)return;Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);var context=new TrayContext(root);if(details)context.ShowDetails();Application.Run(context);
                }
            } catch(Exception e) {MessageBox.Show(e.Message,"Sunshine display health",MessageBoxButtons.OK,MessageBoxIcon.Warning);}
        }
    }
}
