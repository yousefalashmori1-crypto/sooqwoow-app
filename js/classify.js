/** Payment gateway names -> our payment method. Unknown gateways return null (goes to "needs review"). */
export function classifyPayment(gatewayNames, map) {
    const names = gatewayNames.map((n) => n.toLowerCase());
    for (const [needle, method] of Object.entries(map)) {
        if (names.some((n) => n.includes(needle.toLowerCase())))
            return method;
    }
    return null;
}
/** Shopify shipping-method title -> delivery type and carrier key, using the configured map. */
export function mapShippingMethod(title, map) {
    if (!title)
        return null;
    const t = title.toLowerCase();
    const hit = map.find((m) => t.includes(m.match.toLowerCase()));
    return hit ? { carrierKey: hit.carrierKey, deliveryType: hit.deliveryType } : null;
}
