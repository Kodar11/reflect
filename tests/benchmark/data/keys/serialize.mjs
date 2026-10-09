// Writes a day file back in the layout it was read in, so an annotation shows up in a diff as the lines it adds
// and nothing else: the file's line endings, its final newline (or lack of one) and its one-line number arrays.

const INLINE_NUMBERS = /\[\d+(?:, \d+)+\]/;
const INLINE_STRINGS = /\["[^"\n]*"(?:, "[^"\n]*")+\]/;

export function serializeLike(value, originalText) {
  let text = JSON.stringify(value, null, 2);
  if (INLINE_NUMBERS.test(originalText) || /\[\d+\]/.test(originalText)) {
    text = text.replace(/\[\n\s+(-?\d+(?:\.\d+)?(?:,\n\s+-?\d+(?:\.\d+)?)*)\n\s+\]/g, (_, inner) => `[${inner.split(/,\n\s+/).join(', ')}]`);
  }
  if (INLINE_STRINGS.test(originalText)) {
    text = text.replace(/\[\n\s+("(?:[^"\\\n]|\\.)*"(?:,\n\s+"(?:[^"\\\n]|\\.)*")*)\n\s+\]/g, (whole, inner) => {
      const oneLine = `[${inner.split(/,\n\s+/).join(', ')}]`;
      // Only the arrays the file itself kept on one line.
      return originalText.includes(oneLine) ? oneLine : whole;
    });
  }
  if (originalText.includes('\r\n')) text = text.replace(/\n/g, '\r\n');
  if (/\r?\n$/.test(originalText)) text += originalText.includes('\r\n') ? '\r\n' : '\n';
  return text;
}
