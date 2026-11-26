import { createContext } from "react";

/** Inactive retained pages keep their last read projection until they are current again. */
export const SnapshotVisibility = createContext(true);
