/**
 * The canonical identifier of a building within one deed.
 *
 * Remove all Unicode whitespace (including zero-width copy/paste characters),
 * normalize full-width characters and Arabic/Persian numerals, and fold case.
 * Keep punctuation such as hyphens because it can be meaningful in identifiers.
 *
 * This is shared by registry lookup, new writes and legacy-record comparisons.
 */
export const normalizeBuildingNumber = (value) =>
  String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s\u200B-\u200D\uFEFF]+/gu, '')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06F0))
    .toUpperCase();
