export const audienceSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    jobs: { type: 'array', items: { $ref: '#/$defs/insight' }, maxItems: 8 },
    pains: { type: 'array', items: { $ref: '#/$defs/insight' }, maxItems: 8 },
    gains: { type: 'array', items: { $ref: '#/$defs/insight' }, maxItems: 8 },
    questions: { type: 'array', items: { type: 'string' }, maxItems: 8 },
  }, required: ['summary','jobs','pains','gains','questions'],
  $defs: { insight: { type: 'object', additionalProperties: false, properties: { statement: { type:'string' }, basis: { enum:['evidence','assumption'] }, evidenceSourceId: { type:['string','null'] } }, required:['statement','basis','evidenceSourceId'] } },
} as const;

export const namesSchema = {
  type:'object', additionalProperties:false, properties:{ candidates:{ type:'array', minItems:1, maxItems:20, items:{ type:'object', additionalProperties:false, properties:{ name:{type:'string'}, rationale:{type:'string'}, domainSlug:{type:'string'} }, required:['name','rationale','domainSlug'] } } }, required:['candidates'],
} as const;

export const paletteSchema = {
  type:'object', additionalProperties:false, properties:{ colors:{ type:'array', minItems:4, maxItems:6, items:{ type:'object', additionalProperties:false, properties:{ role:{enum:['primary','secondary','accent','background','surface','text']}, hex:{type:'string',pattern:'^#[0-9A-Fa-f]{6}$'} }, required:['role','hex'] } } }, required:['colors'],
} as const;
