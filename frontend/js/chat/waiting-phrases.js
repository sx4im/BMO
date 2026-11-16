export const ROTATING_PHRASES = [
  "Extrapolating…",
  "Adjudicating…",
  "Disambiguating…",
  "Triangulating…",
  "Ruminating…",
  "Elucidating…",
  "Deliberating…",
  "Contextualizing…",
  "Operationalizing…",
  "Instantiating…",
  "Substantiating…",
  "Corroborating…",
  "Reconciling…",
  "Interpolating…",
  "Delineating…",
  "Disaggregating…",
  "Recalibrating…",
  "Abstracting…",
  "Generalizing…",
  "Rationalizing…",
  "Codifying…",
  "Demystifying…",
  "Excavating…",
  "Marshaling…",
  "Orchestrating…",
  "Harmonizing…",
  "Reconfiguring…",
  "Problematizing…",
  "Metabolizing…",
  "Extemporizing…",
];

let lastIndex = -1;

export function getRandomPhrase() {
  // Select among all other entries without retrying if random values repeat.
  const count = ROTATING_PHRASES.length;
  let index = Math.floor(Math.random() * (lastIndex < 0 ? count : count - 1));
  if (lastIndex >= 0 && index >= lastIndex) index++;
  lastIndex = index;
  return ROTATING_PHRASES[index];
}
