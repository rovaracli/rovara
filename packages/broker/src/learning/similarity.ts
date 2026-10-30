// STUB for the RED run (B2): the real implementation follows in the next commit.
export type Signature = readonly string[];
export interface DocumentFrequency { readonly total: number; readonly counts: ReadonlyMap<string, number> }
export interface SignatureComparison { jaccard: number; containment: number; similar: boolean }
export const SIMILARITY_JACCARD_MIN = 0.45;
export const SIMILARITY_CONTAINMENT_MIN = 0.8;
export const CONTAINMENT_MIN_HASHES = 8;
export const signatureWords = (text: string): string[] => text.split(" ");
export const signatureOf = (text: string, _salt: string): Signature => [text];
export const buildDocumentFrequency = (_signatures: readonly Signature[]): DocumentFrequency => ({ total: 0, counts: new Map() });
export const compareSignatures = (a: Signature, b: Signature, _frequency?: DocumentFrequency): SignatureComparison => ({ jaccard: a === b ? 1 : 0, containment: 0, similar: a === b });
export const isSimilar = (a: Signature, b: Signature, frequency?: DocumentFrequency): boolean => compareSignatures(a, b, frequency).similar;
