const receipts = new WeakMap<object, readonly string[]>();
/** In-process identity proof; user/model JSON cannot claim an already-sent response. */
export function recordV2Delivery(result: object, messageIds: readonly string[]): void {
  if (!messageIds.length || messageIds.some(id => !id.trim())) throw new Error('V2_DELIVERY_RECEIPT_REQUIRED');
  receipts.set(result, Object.freeze([...messageIds]));
}
export function v2DeliveryReceipt(result: object): readonly string[] | undefined { return receipts.get(result); }
