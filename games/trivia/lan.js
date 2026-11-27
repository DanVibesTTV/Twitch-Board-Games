// Same-WiFi play: the host's question bank is live (fetched, shuffled), so other phones can't
// rebuild it. On the host every drawn question is recorded and sent along with the move; the
// other phones' game takes questions from that list in the same order. (Session: lanStart /
// lanApply records, followStart / followApply.)
export const lan = {
  hostCtx(ctx, record) {
    const bank = ctx?.bank;
    if (!bank) return ctx;
    const slots = ctx.slots ?? bank.slots;
    // Drawn with the bank's own randomness, not the game RNG, so every copy of the game uses the
    // game RNG identically.
    const own = { next: Math.random };
    return { ...ctx, slots, bank: { slots, take: (slot) => record(bank.take(slot, own)) } };
  },
  spec(ctx) { return { slots: ctx?.slots ?? null }; },
  clientCtx(spec, next) {
    const slots = spec?.slots;
    if (!slots) return null;
    return { slots, bank: { slots, take: () => next() } };
  },
};
