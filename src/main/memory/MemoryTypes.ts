export interface MemoryHit {
  file: string;
  content: string;
  score: number;
  updatedAt: number;
}

export interface MemorySearchOptions {
  limit?: number;
  maxFiles?: number;
  maxCharsPerHit?: number;
}
