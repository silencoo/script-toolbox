using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;

namespace SunshineDisplay
{
    public sealed class DisconnectReport
    {
        public long Id { get; private set; }
        public string Summary { get; private set; }
        public bool Warn { get; private set; }
        public string LocalTime { get { return new DateTime(Id,DateTimeKind.Utc).ToLocalTime().ToString("g"); } }

        internal static DisconnectReport Read(Dictionary<string,object> data) {
            long id,seconds;
            if(data==null || !Int64.TryParse(TrayHealth.Text(data,"Id"),out id) || id<=0 || id>DateTime.MaxValue.Ticks ||
               !Int64.TryParse(TrayHealth.Text(data,"Seconds"),out seconds) || seconds<0) return null;
            switch(TrayHealth.Text(data,"Outcome")) {
                case "Pending": return new DisconnectReport{Id=id,Summary="Checking physical display"};
                case "WaitingForMonitor": return new DisconnectReport{Id=id,Summary="Waiting for physical monitor"};
                case "Restored": return new DisconnectReport{Id=id,Summary="Physical display restored after "+seconds+" s"};
                case "Late": return new DisconnectReport{Id=id,Summary="Physical display restored late, after "+seconds+" s",Warn=true};
                case "Failed": return new DisconnectReport{Id=id,Summary="Windows had not returned to the physical monitor alone after "+seconds+" s",Warn=true};
                case "Unverified": return new DisconnectReport{Id=id,Summary="Restoration unverified"};
                default: return null;
            }
        }
    }

    public enum PrivacyObservation { Unknown, PhysicalActive, VerifiedPrivate, Disconnected }

    public sealed class PrivacyIncident
    {
        public bool Pending { get; private set; }
        bool exposureOpen;

        public PrivacyIncident(bool pending) { Pending=pending; }

        // Unknown observations neither resolve an incident nor re-arm its one-shot sound.
        public bool Observe(PrivacyObservation observation) {
            if(observation==PrivacyObservation.VerifiedPrivate || observation==PrivacyObservation.Disconnected)
                exposureOpen=false;
            if(observation!=PrivacyObservation.PhysicalActive || exposureOpen) return false;
            exposureOpen=true;
            Pending=true;
            return true;
        }

        public void Acknowledge() { Pending=false; }
    }

    public static class StreamingPrivacy
    {
        static Dictionary<string,object>[] Records(Dictionary<string,object> data,string key) {
            var values=TrayHealth.Get(data,key) as IList;
            return values==null ? new Dictionary<string,object>[0] : values.OfType<Dictionary<string,object>>().ToArray();
        }

        static bool ReadTime(object value,out DateTimeOffset time) {
            if(value is DateTime) { time=new DateTimeOffset((DateTime)value); return true; }
            return DateTimeOffset.TryParse(Convert.ToString(value),out time);
        }

        // Called only for fresh, current-boot schema-2 snapshots. The privacy monitor adds Phase.
        public static void Evaluate(Dictionary<string,object> data,HealthView view) {
            var health=TrayHealth.Get(data,"Health") as Dictionary<string,object>;
            var phase=TrayHealth.Text(health,"Phase");
            int clients;
            if(!Int32.TryParse(TrayHealth.Text(data,"Clients"),out clients)) return;
            var processes=Records(data,"SunshineProcesses");
            var reason=TrayHealth.Text(health,"Reason");
            if(clients==0 && phase=="Idle" && reason=="PhysicalOnlyIdleTopologyVerified") {
                view.Privacy=PrivacyObservation.Disconnected;
                return;
            }
            DateTimeOffset start,epoch;
            if(processes.Length!=1 || !ReadTime(TrayHealth.Get(processes[0],"StartTime"),out start)
                || !ReadTime(TrayHealth.Get(data,"LogEpoch"),out epoch) || Math.Abs((epoch-start).TotalSeconds)>15) return;
            if(clients==0 && phase=="Idle" && reason!="SessionSetupInProgress") {
                view.Privacy=PrivacyObservation.Disconnected;
                return;
            }
            if(clients<=0 || phase!="Streaming") return;
            view.StreamConnected=true;
            var active=Records(data,"DisplayPaths").Where(p=>Object.Equals(TrayHealth.Get(p,"Active"),true)).ToArray();
            var expectedPhysical=TrayHealth.Text(data,"ExpectedPhysicalMonitor");
            var physical=active.Where(p=>Object.Equals(TrayHealth.Get(p,"PhysicalConnector"),true) ||
                (expectedPhysical.Length>0 && String.Equals(TrayHealth.Text(p,"InstanceId"),expectedPhysical,StringComparison.OrdinalIgnoreCase))).ToArray();
            if(physical.Length>0) {
                view.Privacy=PrivacyObservation.PhysicalActive;
                var name=TrayHealth.Text(physical[0],"FriendlyName").Trim();
                view.PhysicalOutput=physical.Length>1 ? "multiple physical monitors" :
                    (name.Length==0 ? "a physical monitor" : name);
                view.State="Fault";
                view.Detail="Windows is sending desktop output to "+view.PhysicalOutput+".";
            } else if(active.Length==1 && view.State=="Privacy streaming" && TrayHealth.Text(data,"ExpectedMonitor").Length>0 &&
                String.Equals(TrayHealth.Text(active[0],"InstanceId"),TrayHealth.Text(data,"ExpectedMonitor"),StringComparison.OrdinalIgnoreCase)) {
                view.Privacy=PrivacyObservation.VerifiedPrivate;
            }
        }
    }
}
