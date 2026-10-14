import { z } from 'zod';
import type { ProductivityDelivery, TurnContext } from '@templelabs/contracts';
import type { ManifestDeliveryTransport } from './delivery-manifest.js';

/** Explicit backend recipient binding; this isolated adapter never writes the legacy single-message checkpoint. */
export function createKapsoTextTransport(config: { readonly userId: string; readonly apiKey: string;
  readonly phoneNumberId: string; readonly recipient: { readonly kind: 'phone' | 'bsuid'; readonly value: string } }, fetcher: typeof fetch = fetch): ManifestDeliveryTransport {
  const userId=config.userId, key=config.apiKey, phoneId=config.phoneNumberId, recipient=structuredClone(config.recipient);
  if(!userId || !key.trim() || !/^\d+$/.test(phoneId)
    || (recipient.kind==='phone' ? !/^[1-9]\d{7,14}$/.test(recipient.value) : !recipient.value.trim())) throw new Error('INVALID_DELIVERY_BINDING');
  const validate=(message:ProductivityDelivery)=>{
    if(message.kind!=='text' || !message.text.trim() || message.text.length>4000) throw new Error('UNSUPPORTED_DELIVERY_MESSAGE');
  };
  return {
    validate,
    async send(message:ProductivityDelivery,context:TurnContext) {
      validate(message);
      if(context.userId!==userId) throw new Error('DELIVERY_RECIPIENT_OWNER_MISMATCH');
      const signal=AbortSignal.any([context.signal,AbortSignal.timeout(15000)]);
      signal.throwIfAborted();
      const payload={messaging_product:'whatsapp',...(recipient.kind==='phone' ? {to:recipient.value}:{recipient:recipient.value}),type:'text',text:{body:message.text}};
      // One attempt. No fallback/retry can bypass the manifest's persisted attempted fence.
      const response=await fetcher(`https://api.kapso.ai/meta/whatsapp/v24.0/${phoneId}/messages`,{
        method:'POST',headers:{'X-API-Key':key,'Content-Type':'application/json'},body:JSON.stringify(payload),signal,
      });
      signal.throwIfAborted();
      if(!response.ok) throw new Error('DELIVERY_PROVIDER_UNCONFIRMED');
      const data=z.object({messages:z.array(z.object({id:z.string().trim().min(1).max(256)})).length(1)}).parse(await response.json());
      signal.throwIfAborted();
      return {messageId:data.messages[0]!.id};
    },
  };
}
