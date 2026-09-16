export interface Violation {
  rule: string;
  message: string;
  measured?: number | string;
  threshold?: number | string;
  unit?: string;
}
