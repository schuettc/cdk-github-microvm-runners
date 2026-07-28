import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type JsiiType = {
  name: string;
  assembly: string;
  kind: string;
  datatype?: boolean;
  docs?: { example?: string };
};

const assembly = JSON.parse(
  readFileSync(join(__dirname, '..', '.jsii'), 'utf8'),
) as { name: string; types: Record<string, JsiiType> };

// Structs are documented property-by-property and read as parameter lists, not
// as things you call; an example on one would duplicate the example on the
// factory that takes it.
const behavioural = Object.values(assembly.types).filter(
  (t) => t.assembly === assembly.name && !t.datatype && t.kind !== 'enum',
);

describe('Construct Hub example coverage', () => {
  it.each(behavioural.map((t) => [t.name, t]))(
    '%s carries an @example',
    (_name, type) => {
      expect((type as JsiiType).docs?.example).toBeTruthy();
    },
  );
});
