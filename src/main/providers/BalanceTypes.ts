/** The slice of a model profile the balance service needs. */
export interface ModelProfileLike {
  id: string;
  provider: string;
  apiKey: string;
  baseURL?: string;
  userAgent?: string;
}
