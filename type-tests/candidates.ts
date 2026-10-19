import type { CandidateSource, CandidateRunner, CandidateReview } from "wish/candidates";
import type { AgentProfileSnapshot } from "wish/agent-profiles/types";
declare const source: CandidateSource;
declare const snapshot: AgentProfileSnapshot;
declare const runner: CandidateRunner;
declare const review: CandidateReview;
// @ts-expect-error Immutable source identity cannot be edited in place.
source.version = 3;
// @ts-expect-error Candidate manifests declare an explicit trust boundary.
source.manifest.sandbox.isolation = "safe-vm";
// @ts-expect-error Approval pins a reviewed artifact.
review.artifactDigest = "different";
const classification: string | undefined = snapshot.candidate?.artifactDigest;
void classification;
void runner;
