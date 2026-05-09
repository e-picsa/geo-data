export interface CacheProvider {
  get<T>(key: string): Promise<T | null>;
  set(key: string, data: any): Promise<void>;
  clear(): Promise<void>;
  clearPrefix?(prefix: string): Promise<void>;
}
