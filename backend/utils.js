export function splitTextIntoChunks(text, maxTokens = 200) {
  const words = text.split(/\s+/);
  const estimatedTokensPerWord = 2.5;
  const maxWords = Math.floor(maxTokens / estimatedTokensPerWord);
  let chunks = [];
  let currentChunk = [];

  for (const word of words) {
    if (currentChunk.length + 1 > maxWords) {
      chunks.push(currentChunk.join(" "));
      currentChunk = [word];
    } else {
      currentChunk.push(word);
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(" "));
  }

  return chunks;
}
