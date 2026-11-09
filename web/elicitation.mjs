function choices(schema) {
  if (Array.isArray(schema?.enum) && schema.enum.every(value => typeof value === 'string')) {
    return schema.enum.map((value, i) => ({ value, label: schema.enumNames?.[i] ?? value }));
  }
  const options = schema?.oneOf ?? schema?.anyOf;
  if (Array.isArray(options) && options.every(option => typeof option?.const === 'string')) {
    return options.map(option => ({ value: option.const, label: option.title ?? option.const }));
  }
  return null;
}

export function formFields(schema) {
  if (schema?.type !== 'object' || !schema.properties || Array.isArray(schema.properties) ||
      typeof schema.properties !== 'object') return null;
  if (schema.required !== undefined && !Array.isArray(schema.required)) return null;
  const fields = Object.entries(schema.properties).map(([name, field]) => {
    if (!field || !['string', 'number', 'integer', 'boolean', 'array'].includes(field.type)) return null;
    const options = choices(field.type === 'array' ? field.items : field);
    if ((field.type === 'array' || field.enum || field.oneOf || field.anyOf) && !options?.length) return null;
    if (field.format && !['email', 'uri', 'date', 'date-time'].includes(field.format)) return null;
    return { ...field, name, options, required: schema.required?.includes(name) ?? false };
  });
  if (fields.includes(null) || schema.required?.some(name => !Object.hasOwn(schema.properties, name))) return null;
  return fields;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validField(field, value) {
  const allowed = item => field.options.some(option => option.value === item);
  if (field.type === 'array') {
    return Array.isArray(value) && value.every(allowed) && new Set(value).size === value.length &&
      value.length >= (field.minItems ?? 0) && value.length <= (field.maxItems ?? Infinity);
  }
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'number' || field.type === 'integer') {
    return Number.isFinite(value) && (field.type !== 'integer' || Number.isInteger(value)) &&
      value >= (field.minimum ?? -Infinity) && value <= (field.maximum ?? Infinity);
  }
  if (typeof value !== 'string' || (field.options && !allowed(value))) return false;
  const length = [...value].length;
  if (length < (field.minLength ?? 0) || length > (field.maxLength ?? Infinity)) return false;
  if (field.format === 'email') return /^[^\s@]+@[^\s@]+$/.test(value);
  if (field.format === 'uri') return URL.canParse(value);
  if (field.format === 'date') return validDate(value);
  if (field.format === 'date-time') {
    return validDate(value.slice(0, 10)) &&
      /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) &&
      Number.isFinite(Date.parse(value));
  }
  return true;
}

export function externalUrl(value) {
  if (typeof value !== 'string') return null;
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.username && !url.password ? url.href : null;
}
