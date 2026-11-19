using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Media;
using System.Windows.Forms;

namespace SunshineDisplay
{
    internal sealed class PrivacyWarnings : IDisposable
    {
        readonly Dictionary<string,PrivacyWarningForm> windows=new Dictionary<string,PrivacyWarningForm>();
        readonly PrivacyIncident incident;
        readonly string marker;
        readonly Action details;
        bool saved;
        internal string StorageError { get; private set; }

        internal PrivacyWarnings(string markerPath,Action showDetails) {
            marker=markerPath;
            details=showDetails;
            saved=File.Exists(marker);
            incident=new PrivacyIncident(saved);
        }
        internal void Refresh(HealthView view) {
            bool sound=incident.Observe(view.Privacy);
            SavePending();
            if(!incident.Pending) return;
            var screens=Screen.AllScreens;
            foreach(var removed in windows.Keys.Except(screens.Select(s=>s.DeviceName)).ToArray()) {
                windows[removed].Dispose();
                windows.Remove(removed);
            }
            foreach(var screen in screens) {
                PrivacyWarningForm window;
                if(!windows.TryGetValue(screen.DeviceName,out window)) {
                    window=new PrivacyWarningForm(Acknowledge,details);
                    window.Location=screen.WorkingArea.Location;
                    windows.Add(screen.DeviceName,window);
                }
                window.Present(view,screen.WorkingArea);
            }
            if(sound) SystemSounds.Exclamation.Play();
        }
        void Acknowledge() {
            incident.Acknowledge();
            CloseWindows();
            SavePending();
        }
        void SavePending() {
            if(saved==incident.Pending) { StorageError=null; return; }
            try {
                if(incident.Pending) {
                    Directory.CreateDirectory(Path.GetDirectoryName(marker));
                    using(File.Create(marker)) { }
                } else File.Delete(marker);
                saved=incident.Pending;
                StorageError=null;
            } catch(IOException ex) { StorageError=ex.Message; }
              catch(UnauthorizedAccessException ex) { StorageError=ex.Message; }
        }
        void CloseWindows() {
            foreach(var window in windows.Values) window.Dispose();
            windows.Clear();
        }
        public void Dispose() { CloseWindows(); }
    }

    internal sealed class PrivacyWarningForm : Form
    {
        static readonly Color Surface=Color.FromArgb(37,38,42);
        static readonly Color Ink=Color.FromArgb(246,245,242);
        readonly Font bodyFont=new Font("Segoe UI",10);
        readonly Font titleFont=new Font("Segoe UI",17,FontStyle.Bold);
        readonly Font brandFont=new Font("Segoe UI Semibold",10);
        readonly Label brand=new Label(),title=new Label(),body=new Label(),note=new Label();
        readonly PictureBox mark=new PictureBox {SizeMode=PictureBoxSizeMode.Zoom};
        readonly Button acknowledge=new Button(),details=new Button();
        internal PrivacyWarningForm(Action onAcknowledge,Action onDetails) {
            Text="Sunshine Display Health";
            TopMost=true;
            ShowInTaskbar=false;
            StartPosition=FormStartPosition.Manual;
            FormBorderStyle=FormBorderStyle.None;
            AutoScaleMode=AutoScaleMode.None;
            BackColor=Surface;
            Font=bodyFont;
            Padding=new Padding(1);
            foreach(var label in new[]{brand,title,body,note}) {
                label.UseMnemonic=false;
                label.ForeColor=Ink;
                Controls.Add(label);
            }
            brand.Font=brandFont;
            brand.Text=Text;
            brand.TextAlign=ContentAlignment.MiddleLeft;
            title.Font=titleFont;
            note.ForeColor=Color.FromArgb(215,214,217);
            using(var stream=typeof(PrivacyWarningForm).Assembly.GetManifestResourceStream("SunshineDisplay.fault.ico"))
            using(var icon=new Icon(stream,64,64)) mark.Image=icon.ToBitmap();
            Controls.Add(mark);
            ConfigureButton(acknowledge,"Acknowledge",Color.FromArgb(255,179,39),Color.FromArgb(26,23,17),onAcknowledge);
            ConfigureButton(details,"View details",Color.FromArgb(58,59,65),Ink,onDetails);
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        void ConfigureButton(Button button,string caption,Color background,Color foreground,Action click) {
            button.Text=caption;
            button.FlatStyle=FlatStyle.Flat;
            button.FlatAppearance.BorderColor=Color.FromArgb(105,105,112);
            button.BackColor=background;
            button.ForeColor=foreground;
            button.Click+=(s,e)=>click();
            Controls.Add(button);
        }
        internal void Present(HealthView view,Rectangle work) {
            switch(view.Privacy) {
                case PrivacyObservation.PhysicalActive:
                    title.Text="Privacy warning";
                    body.Text=view.Detail;
                    note.Text="People near the monitor may be able to see your desktop.";
                    break;
                case PrivacyObservation.VerifiedPrivate:
                    title.Text="Privacy restored";
                    body.Text="A physical monitor was active during streaming.";
                    note.Text="Windows is now using only the virtual display.";
                    break;
                case PrivacyObservation.Disconnected:
                    title.Text="Stream ended";
                    body.Text="A physical monitor was active during streaming.";
                    note.Text="Sunshine now has no connected clients.";
                    break;
                default:
                    title.Text="Privacy warning";
                    body.Text="A physical monitor was active during streaming.";
                    note.Text="The current display state is unverified.";
                    break;
            }
            // Create the handle on the target monitor before reading its per-monitor DPI.
            var handle=Handle;
            int pad=ScalePixels(18),gap=ScalePixels(8),margin=ScalePixels(12);
            int width=Math.Min(ScalePixels(440),work.Width-2*margin),inner=width-2*pad;
            int y=pad,logo=ScalePixels(24);
            mark.SetBounds(pad,y,logo,logo);
            brand.SetBounds(pad+logo+gap,y,inner-logo-gap,logo);
            y+=logo+gap;
            foreach(var label in new[]{title,body,note}) {
                int height=TextRenderer.MeasureText(label.Text,label.Font,new Size(inner,Int32.MaxValue),
                    TextFormatFlags.WordBreak|TextFormatFlags.NoPrefix).Height+ScalePixels(2);
                label.SetBounds(pad,y,inner,height);
                y+=height+gap;
            }
            int half=(inner-gap)/2,buttonHeight=ScalePixels(34);
            acknowledge.SetBounds(pad,y,half,buttonHeight);
            details.SetBounds(pad+half+gap,y,inner-half-gap,buttonHeight);
            int heightNeeded=y+buttonHeight+pad;
            Bounds=new Rectangle(work.Right-margin-width,work.Bottom-margin-heightNeeded,width,heightNeeded);
            if(!Visible) Show();
        }
        int ScalePixels(int value) { return (int)Math.Round(value*DeviceDpi/96.0); }
        protected override void OnFormClosing(FormClosingEventArgs e) {
            base.OnFormClosing(e);
            if(e.CloseReason==CloseReason.UserClosing) e.Cancel=true;
        }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e);
            ControlPaint.DrawBorder(e.Graphics,ClientRectangle,Color.FromArgb(109,110,116),ButtonBorderStyle.Solid);
        }
        protected override void Dispose(bool disposing) {
            if(disposing) {
                if(mark.Image!=null) {mark.Image.Dispose();mark.Image=null;}
                bodyFont.Dispose();titleFont.Dispose();brandFont.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
