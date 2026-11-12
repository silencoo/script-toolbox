using System;

namespace SunshineDisplay
{
    public interface IRecoveryEnvironment
    {
        double ElapsedSeconds {get;}
        void AssertSafe();
        string Fingerprint();
        bool PhysicalMatches();
        void BackupAndApply();
        void Wait();
        void Publish(string detail,int attempts);
    }
    public sealed class RecoveryOutcome {public string Result;public string Detail;public int Attempts;}
    public static class RecoveryEngine
    {
        public static RecoveryOutcome Run(IRecoveryEnvironment e,int timeout,int maxAttempts) {
            if(timeout<10 || timeout>90 || maxAttempts<1 || maxAttempts>3) throw new ArgumentException("Invalid recovery bounds");
            int attempts=0,stable=0;string fingerprint=null,last="Waiting for GPU/display enumeration";
            try {
                while(e.ElapsedSeconds<timeout) {
                    e.AssertSafe(); // Unknown or lost coordination is terminal, never an enumeration retry.
                    try {
                        string next=e.Fingerprint();stable=next==fingerprint?stable+1:0;fingerprint=next;
                        e.Publish(last,attempts);
                        if(stable>=2) {
                            if(e.PhysicalMatches()) {
                                e.Wait();e.AssertSafe();
                                if(e.PhysicalMatches()) return new RecoveryOutcome{Result="Succeeded",Detail="Fresh CCD physical paths and independent GDI identities/primary/modes verified. Visible picture unverified.",Attempts=attempts};
                            }
                            if(attempts>=maxAttempts) return new RecoveryOutcome{Result="Fault",Detail="Verification failed after bounded apply attempts",Attempts=attempts};
                            e.AssertSafe();attempts++;e.BackupAndApply();last="Applied; awaiting independent verification";stable=0;fingerprint=null;
                        }
                    } catch(OperationCanceledException) {throw;}
                      catch(Exception ex) {last=ex.Message;stable=0;e.Publish(last,attempts);if(attempts>=maxAttempts)return new RecoveryOutcome{Result="Fault",Detail=last,Attempts=attempts};}
                    e.Wait();
                }
                return new RecoveryOutcome{Result="Fault",Detail="Enumeration/verification timeout: "+last,Attempts=attempts};
            } catch(OperationCanceledException ex) {return new RecoveryOutcome{Result="Cancelled",Detail=ex.Message,Attempts=attempts};}
              catch(Exception ex) {return new RecoveryOutcome{Result="Fault",Detail=ex.Message,Attempts=attempts};}
        }
    }
}
