export type FormField = {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  required: boolean;
  title?: string;
  description?: string;
  options: { value: string; label: string }[] | null;
  default?: string | boolean | number | string[];
  format?: 'email' | 'uri' | 'date' | 'date-time';
  minimum?: number;
  maximum?: number;
};

export function formFields(schema: unknown): FormField[] | null;
export function validField(field: FormField, value: unknown): boolean;
export function externalUrl(value: unknown): string | null;
