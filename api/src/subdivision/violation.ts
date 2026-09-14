export interface Violation {
  rule: string;
  child_index?: number;
  message: string;
  measured?: number | string;
  threshold?: number | string;
  unit?: string;
}
