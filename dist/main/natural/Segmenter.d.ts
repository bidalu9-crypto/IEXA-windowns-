/**
 * Split one assistant reply into the short bursts a person would actually send.
 *
 * A model answers in paragraphs; a person sends a line, waits, sends another.
 * This cuts a reply on sentence boundaries, merges fragments that are too short
 * to stand alone and splits clauses that are too long to read as one message, so
 * the result varies in length instead of being a wall of text chopped evenly.
 *
 * Timing is not handled here: the caller decides how long to wait between
 * bursts, because that belongs to the delivery surface, not the text.
 */
export declare function segmentNaturalReply(text: string): string[];
//# sourceMappingURL=Segmenter.d.ts.map