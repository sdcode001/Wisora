import type { UserProfile } from "./profile";
import type {
  DecisionRecord,
  Feedback,
  NewDecisionRecord,
  NewFeedback,
  NewSavedComparison,
  NewSavedProduct,
  SavedComparison,
  SavedProduct,
} from "./records";
import type { NewProposal, Proposal, ProposalStatus } from "./proposals";

/**
 * Persistence boundary for per-user memory, keyed by the authenticated
 * user's subject (`sub`). Implementations must isolate users: a caller can
 * only ever read or write data for the sub it passes in.
 *
 * Lists return newest-first. Counts bound file growth; oldest entries
 * beyond the cap are dropped on write.
 */
export interface MemoryStore {
  getProfile(userSub: string): Promise<UserProfile | null>;
  saveProfile(profile: UserProfile): Promise<void>;
  clearProfile(userSub: string): Promise<boolean>;

  listDecisions(userSub: string, limit?: number): Promise<DecisionRecord[]>;
  saveDecision(
    userSub: string,
    input: NewDecisionRecord,
  ): Promise<DecisionRecord>;

  listSavedProducts(userSub: string): Promise<SavedProduct[]>;
  /** Save or update by productId (re-saving refreshes the snapshot). */
  saveSavedProduct(
    userSub: string,
    input: NewSavedProduct,
  ): Promise<SavedProduct>;
  deleteSavedProduct(userSub: string, productId: string): Promise<boolean>;

  listSavedComparisons(userSub: string): Promise<SavedComparison[]>;
  saveSavedComparison(
    userSub: string,
    input: NewSavedComparison,
  ): Promise<SavedComparison>;
  deleteSavedComparison(userSub: string, id: string): Promise<boolean>;

  listFeedback(userSub: string, limit?: number): Promise<Feedback[]>;
  saveFeedback(userSub: string, input: NewFeedback): Promise<Feedback>;

  listProposals(userSub: string): Promise<Proposal[]>;
  saveProposal(userSub: string, input: NewProposal): Promise<Proposal>;
  decideProposal(
    userSub: string,
    id: string,
    status: Exclude<ProposalStatus, "pending">,
  ): Promise<Proposal | null>;

  /** Clear decisions, feedback, and proposals (saved items are kept). */
  clearHistory(userSub: string): Promise<{
    decisions: number;
    feedback: number;
    proposals: number;
  }>;
}
