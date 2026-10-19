/**
 * Boot-seeded service catalogs (insert-only; admin edits win). CLEANILO slugs are the live
 * cleanilo.de URL slugs, so storefront pages and partner services stay stable across the migration.
 */
interface CatalogSeedRow {
  slug: string;
  name: string;
  category: string;
  pricingMode: 'fixed' | 'inquiry';
  orderKind?: string;
}

const T = 'teppich-services';
const P = 'polster-services';
const H = 'haus-and-dachreinigung';
const G = 'garten-und-landschaftsbau';
const S = 'sanierungsarbeiten';
const M = 'modernisierung-and-montage';

const inquiry = (slug: string, name: string, category: string): CatalogSeedRow => ({
  slug,
  name,
  category,
  pricingMode: 'inquiry',
});

const CLEANILO: CatalogSeedRow[] = [
  {
    slug: 'teppichreinigung',
    name: 'Teppichreinigung',
    category: T,
    pricingMode: 'fixed',
    orderKind: 'teppichreinigung',
  },
  {
    slug: 'orientteppichreinigung',
    name: 'Orientteppichreinigung',
    category: T,
    pricingMode: 'fixed',
    orderKind: 'teppichreinigung',
  },
  {
    slug: 'teppichbodenreinigung',
    name: 'Teppichbodenreinigung',
    category: T,
    pricingMode: 'fixed',
    orderKind: 'teppichbodenreinigung',
  },
  {
    slug: 'teppichreparatur',
    name: 'Teppichreparatur',
    category: T,
    pricingMode: 'fixed',
    orderKind: 'teppichreparatur',
  },
  inquiry('fleckenentfernung', 'Fleckentfernung', T),
  inquiry('geruchsbeseitigung-teppich', 'Geruchsbeseitigung Teppich', T),
  inquiry('mottenbekampfung', 'Mottenbekämpfung', T),
  inquiry('polsterreinigung', 'Polsterreinigung', P),
  inquiry('polsterbezug', 'Polsterbezug', P),
  inquiry('geruchsbeseitigung-polster', 'Geruchsbeseitigung Polster', P),
  inquiry('dachreinigung', 'Dachreinigung', H),
  inquiry('fassadenreinigung', 'Fassadenreinigung', H),
  inquiry('gehwegreinigung', 'Gehweg- & Steinreinigung', H),
  inquiry('treppenhausreinigung', 'Treppenhausreinigung', H),
  inquiry('fensterreinigung', 'Fensterreinigung', H),
  inquiry('hausreinigung', 'Hausreinigung', H),
  inquiry('buroreinigung', 'Büroreinigung', H),
  inquiry('gartenarbeiten', 'Gartenarbeiten', G),
  inquiry('pflastersteine-verlegen', 'Pflastersteine verlegen', S),
  inquiry('altbausanierung', 'Altbausanierung', S),
  inquiry('badsanierung', 'Badsanierung', S),
  inquiry('balkonsanierung', 'Balkonsanierung', S),
  inquiry('bausanierung', 'Bausanierung', S),
  inquiry('feuchtigkeitsschaeden-in-gebaeude', 'Feuchtigkeitsschäden in Gebäuden', S),
  inquiry('kellersanierung', 'Kellersanierung', S),
  inquiry('mauerwerkssanierung', 'Mauerwerkssanierung', S),
  inquiry('maurerarbeiten', 'Maurerarbeiten', S),
  inquiry('fliesenarbeiten', 'Fliesenarbeiten', M),
  inquiry('innenausbau', 'Innenausbau', M),
  inquiry('malerarbeiten', 'Malerarbeiten', M),
  inquiry('modernisierung', 'Modernisierung', M),
  inquiry('montagearbeiten', 'Montagearbeiten', M),
  inquiry('oekologisches-bauen', 'Ökologisches Bauen', M),
  inquiry('putzarbeiten', 'Putzarbeiten', M),
  inquiry('trockenbau', 'Trockenbau', M),
  inquiry('waermedaemmung', 'Wärmedämmung', M),
];

export const SERVICE_CATALOG_SEED: Record<string, CatalogSeedRow[]> = {
  cleanilo: CLEANILO,
};
