import type { EvolutionCampaign, EvolutionProposal, EvolutionVerdict, EvolutionApprovalOptions } from "../src/evolution/types.js";
declare const campaign: EvolutionCampaign;
declare const proposal: EvolutionProposal;
declare const verdict: EvolutionVerdict;
// @ts-expect-error Campaign snapshots are immutable.
campaign.revision = 2;
// @ts-expect-error A generator cannot author Host verdicts.
proposal.verdict = verdict;
// @ts-expect-error Host authority cannot be changed to model authority.
verdict.authority = "model";
// @ts-expect-error Explicit approval must pin the exact observed revision.
const approval: EvolutionApprovalOptions = { approvedDigest: "digest", requestId: "request" };
void approval;
