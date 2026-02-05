# Paddle & Lemon Squeezy Payment Integration Plan for Cal.com

## Executive Summary

This document outlines the implementation plan for adding Paddle and Lemon Squeezy as payment processors to your Cal.com fork. Both are Merchant of Record (MoR) providers that handle all tax compliance automatically, making them ideal for global SaaS businesses.

## Why Paddle/Lemon Squeezy?

From your payment processor comparison analysis:
- **Paddle**: Most established MoR, 245+ countries, handles ALL tax automatically
- **Lemon Squeezy**: Modern MoR with better API than Paddle, 135+ countries
- **Cost**: 5% + $0.50 per transaction (vs Stripe's 2.9% + $0.30)
- **Tax Advantage**: They handle all VAT, sales tax, GST - worth the extra cost

## Implementation Strategy

We'll implement **both** Paddle and Lemon Squeezy integrations following Cal.com's app-store pattern. Users can choose which provider to use based on their needs.

## Architecture Overview

### Cal.com Payment Integration Pattern

Cal.com uses a plugin architecture where payment providers implement `IAbstractPaymentService`:

```typescript
interface IAbstractPaymentService {
  create()        // Create payment at booking time
  collectCard()   // Collect card for later charge (no-show fees)
  chargeCard()    // Charge a held card
  refund()        // Process refunds
  afterPayment()  // Post-payment actions
  deletePayment() // Cancel payment
  isSetupAlready()// Check if credentials configured
}
```

### Integration Components

Each payment provider needs:

1. **App Store Directory**: `packages/app-store/{provider}payment/`
2. **Metadata**: `_metadata.ts` defining the app
3. **Payment Service**: `lib/PaymentService.ts` implementing the interface
4. **Webhook Handler**: `apps/web/pages/api/integrations/{provider}payment/webhook.ts`

## Paddle Integration Design

### Directory Structure

```
packages/app-store/paddlepayment/
├── _metadata.ts
├── package.json
├── icon.svg
├── lib/
│   ├── PaymentService.ts      # Main service implementation
│   ├── customer.ts             # Customer management
│   └── server.ts               # Paddle SDK setup
└── zod.ts                      # Validation schemas

apps/web/pages/api/integrations/paddlepayment/
└── webhook.ts                  # Webhook handler
```

### Paddle API Mapping

**Paddle Billing API**: https://developer.paddle.com/api-reference/overview

#### Key Paddle Concepts:

1. **Transaction** - One-time payment (equivalent to Stripe PaymentIntent)
2. **Customer** - User in Paddle system
3. **Price** - Product pricing configuration
4. **Webhook Events**:
   - `transaction.completed` - Payment succeeded
   - `transaction.payment_failed` - Payment failed
   - `transaction.canceled` - Payment canceled

#### Implementation Details:

```typescript
// packages/app-store/paddlepayment/lib/PaymentService.ts
import { Paddle } from '@paddle/paddle-node-sdk';

class PaddlePaymentService implements IAbstractPaymentService {
  private paddle: Paddle;
  private credentials: PaddleCredentials | null;

  constructor(credentials: { key: Prisma.JsonValue }) {
    // Parse credentials from database
    this.credentials = paddleCredentialKeysSchema.safeParse(credentials.key);

    // Initialize Paddle SDK
    this.paddle = new Paddle(process.env.PADDLE_API_KEY || '', {
      environment: process.env.PADDLE_ENVIRONMENT as 'sandbox' | 'production'
    });
  }

  async create(
    payment: Pick<Prisma.PaymentUncheckedCreateInput, "amount" | "currency">,
    bookingId: Booking["id"],
    userId: Booking["userId"],
    username: string | null,
    bookerName: string,
    paymentOption: PaymentOption,
    bookerEmail: string,
    bookerPhoneNumber?: string | null,
    eventTitle?: string,
    bookingTitle?: string
  ): Promise<Payment> {
    // 1. Get or create Paddle customer
    const customer = await this.getOrCreateCustomer(bookerEmail, bookerName);

    // 2. Create Paddle transaction
    const transaction = await this.paddle.transactions.create({
      items: [{
        price: {
          description: bookingTitle || eventTitle || 'Booking',
          unitPrice: {
            amount: payment.amount.toString(),
            currencyCode: payment.currency
          }
        },
        quantity: 1
      }],
      customerId: customer.id,
      customData: {
        bookingId: bookingId.toString(),
        userId: userId?.toString(),
        username: username || '',
        bookerName,
        bookerEmail,
        eventTitle: eventTitle || '',
        bookingTitle: bookingTitle || ''
      }
    });

    // 3. Save payment record in Cal.com database
    const paymentData = await prisma.payment.create({
      data: {
        uid: uuidv4(),
        app: {
          connect: { slug: "paddle" }
        },
        booking: {
          connect: { id: bookingId }
        },
        amount: payment.amount,
        currency: payment.currency,
        externalId: transaction.id,
        data: {
          transaction,
          checkoutUrl: transaction.checkoutUrl,
          paddleCustomerId: customer.id
        } as unknown as Prisma.InputJsonValue,
        fee: 0,
        refunded: false,
        success: false,
        paymentOption: paymentOption || "ON_BOOKING"
      }
    });

    return paymentData;
  }

  async refund(paymentId: Payment["id"]): Promise<Payment | null> {
    const payment = await this.getPayment({ id: paymentId });
    if (!payment) return null;
    if (!payment.success) throw new Error("Cannot refund unpaid transaction");
    if (payment.refunded) return payment;

    // Issue refund through Paddle
    const refund = await this.paddle.adjustments.create({
      action: 'refund',
      transactionId: payment.externalId,
      reason: 'Booking canceled',
      items: [
        {
          type: 'full',
          itemId: (payment.data as any).transaction.items[0].id
        }
      ]
    });

    // Update payment record
    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: { refunded: true }
    });

    return updatedPayment;
  }

  async deletePayment(paymentId: Payment["id"]): Promise<boolean> {
    const payment = await this.getPayment({ id: paymentId });
    if (!payment) return false;

    try {
      // Cancel the transaction in Paddle
      await this.paddle.transactions.cancel(payment.externalId);
      return true;
    } catch (error) {
      log.error("Paddle: Unable to cancel transaction", paymentId, error);
      return false;
    }
  }

  // Additional helper methods...
  private async getOrCreateCustomer(email: string, name: string) {
    // Implementation to find or create Paddle customer
  }

  private async getPayment(where: Prisma.PaymentWhereInput) {
    // Implementation to fetch payment from database
  }
}

export function BuildPaymentService(credentials: { key: Prisma.JsonValue }): IAbstractPaymentService {
  return new PaddlePaymentService(credentials);
}
```

### Paddle Webhook Handler

```typescript
// apps/web/pages/api/integrations/paddlepayment/webhook.ts
import { buffer } from "micro";
import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import { prisma } from "@calcom/prisma";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  // Get signature from header
  const signature = req.headers["paddle-signature"] as string;
  if (!signature) {
    return res.status(400).json({ message: "Missing paddle-signature header" });
  }

  // Read raw body
  const requestBuffer = await buffer(req);
  const payload = requestBuffer.toString();

  // Verify webhook signature
  const isValid = verifyPaddleSignature(payload, signature, process.env.PADDLE_WEBHOOK_SECRET!);
  if (!isValid) {
    return res.status(401).json({ message: "Invalid signature" });
  }

  const event = JSON.parse(payload);

  // Handle different event types
  switch (event.event_type) {
    case "transaction.completed":
      await handleTransactionCompleted(event);
      break;
    case "transaction.payment_failed":
      await handleTransactionFailed(event);
      break;
    case "transaction.canceled":
      await handleTransactionCanceled(event);
      break;
  }

  return res.json({ received: true });
}

async function handleTransactionCompleted(event: any) {
  const transaction = event.data;

  // Find payment record by externalId
  const payment = await prisma.payment.findFirst({
    where: { externalId: transaction.id },
    select: { id: true, bookingId: true }
  });

  if (!payment?.bookingId) {
    throw new Error("Payment not found");
  }

  // Use shared payment success handler
  await handlePaymentSuccess({
    paymentId: payment.id,
    bookingId: payment.bookingId,
    appSlug: "paddle",
    traceContext: {} // Add tracing context
  });
}

function verifyPaddleSignature(payload: string, signature: string, secret: string): boolean {
  // Paddle signature verification
  // See: https://developer.paddle.com/webhooks/verify-webhooks
  const [ts, h1] = signature.split(';').map(part => part.split('=')[1]);

  const signedPayload = `${ts}:${payload}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(h1),
    Buffer.from(expectedSignature)
  );
}
```

### Paddle Metadata Configuration

```typescript
// packages/app-store/paddlepayment/_metadata.ts
import type { AppMeta } from "@calcom/types/App";

export const metadata = {
  name: "Paddle",
  description: "Accept payments globally with Paddle as your Merchant of Record. Paddle handles all tax compliance automatically.",
  installed: !!(
    process.env.PADDLE_API_KEY &&
    process.env.PADDLE_WEBHOOK_SECRET &&
    process.env.PADDLE_ENVIRONMENT
  ),
  slug: "paddle",
  category: "payment",
  categories: ["payment"],
  logo: "icon.svg",
  publisher: "Cal.com",
  title: "Paddle",
  type: "paddle_payment",
  url: "https://www.paddle.com/",
  docsUrl: "https://developer.paddle.com/",
  variant: "payment",
  extendsFeature: "EventType",
  email: "help@cal.com",
  dirName: "paddlepayment",
  isOAuth: false, // Paddle uses API keys, not OAuth
} as AppMeta;

export default metadata;
```

### Paddle-Specific Challenges & Solutions

#### Challenge 1: Paddle doesn't support "hold" payments like Stripe's SetupIntent

**Solution**: For `collectCard()` method (used for no-show fees), we have two options:

**Option A** - Skip Implementation:
```typescript
async collectCard(): Promise<Payment> {
  throw new Error("Paddle does not support hold payments. Use ON_BOOKING payment option only.");
}
```

**Option B** - Use Paddle's Payment Link with delayed capture:
```typescript
async collectCard(
  payment: Pick<Prisma.PaymentUncheckedCreateInput, "amount" | "currency">,
  bookingId: Booking["id"],
  paymentOption: PaymentOption,
  bookerEmail: string
): Promise<Payment> {
  // Create a transaction that won't be charged immediately
  // Store payment method for later use
  const customer = await this.getOrCreateCustomer(bookerEmail);

  // Create a payment link that can be used later
  const transaction = await this.paddle.transactions.create({
    items: [/* ... */],
    customerId: customer.id,
    billing_details: {
      enable_checkout: true,
      purchase_order_number: `hold-${bookingId}`
    }
  });

  // Save with special flag indicating it's a hold payment
  return await prisma.payment.create({
    data: {
      // ... standard payment fields
      paymentOption: "HOLD",
      data: {
        transaction,
        isHoldPayment: true,
        checkoutUrl: transaction.checkoutUrl
      } as unknown as Prisma.InputJsonValue
    }
  });
}
```

**Recommendation**: Option A (skip hold payments). Paddle is designed for immediate capture, and most booking scenarios don't need hold payments.

#### Challenge 2: Paddle uses checkout URLs instead of embedded checkout

**Solution**: Redirect users to Paddle's hosted checkout page:

```typescript
// In booking flow, redirect to Paddle checkout URL
const payment = await paddleService.create(/* ... */);
const checkoutUrl = (payment.data as any).checkoutUrl;

// Redirect user
return Response.redirect(checkoutUrl);
```

After payment, Paddle redirects back to your site with success URL.

#### Challenge 3: Currency handling

Paddle requires 3-letter ISO currency codes and amounts as strings:

```typescript
const transaction = await this.paddle.transactions.create({
  items: [{
    price: {
      unitPrice: {
        amount: payment.amount.toString(),  // Convert to string
        currencyCode: payment.currency.toUpperCase()  // Ensure uppercase
      }
    }
  }]
});
```

---

## Lemon Squeezy Integration Design

### Directory Structure

```
packages/app-store/lemonsqueezypayment/
├── _metadata.ts
├── package.json
├── icon.svg
├── lib/
│   ├── PaymentService.ts      # Main service implementation
│   ├── customer.ts             # Customer management
│   └── server.ts               # Lemon Squeezy SDK setup
└── zod.ts                      # Validation schemas

apps/web/pages/api/integrations/lemonsqueezypayment/
└── webhook.ts                  # Webhook handler
```

### Lemon Squeezy API Mapping

**Lemon Squeezy API**: https://docs.lemonsqueezy.com/api

#### Key Lemon Squeezy Concepts:

1. **Checkout** - Payment session (like Stripe Checkout)
2. **Order** - Completed purchase
3. **Customer** - User in Lemon Squeezy
4. **Webhook Events**:
   - `order_created` - Order created (payment succeeded)
   - `order_refunded` - Order refunded

#### Implementation Details:

```typescript
// packages/app-store/lemonsqueezypayment/lib/PaymentService.ts
import { LemonSqueezy } from '@lemonsqueezy/lemonsqueezy.js';

class LemonSqueezyPaymentService implements IAbstractPaymentService {
  private client: LemonSqueezy;
  private credentials: LemonSqueezyCredentials | null;

  constructor(credentials: { key: Prisma.JsonValue }) {
    this.credentials = lemonSqueezyCredentialKeysSchema.safeParse(credentials.key);

    this.client = new LemonSqueezy(process.env.LEMONSQUEEZY_API_KEY || '');
  }

  async create(
    payment: Pick<Prisma.PaymentUncheckedCreateInput, "amount" | "currency">,
    bookingId: Booking["id"],
    userId: Booking["userId"],
    username: string | null,
    bookerName: string,
    paymentOption: PaymentOption,
    bookerEmail: string,
    bookerPhoneNumber?: string | null,
    eventTitle?: string,
    bookingTitle?: string
  ): Promise<Payment> {
    // 1. Create checkout session
    const checkout = await this.client.createCheckout({
      storeId: this.credentials.storeId,
      variantId: this.credentials.variantId,  // Product variant ID
      customPrice: payment.amount,  // Lemon Squeezy supports custom pricing
      checkoutData: {
        email: bookerEmail,
        name: bookerName,
        custom: {
          bookingId: bookingId.toString(),
          userId: userId?.toString(),
          username: username || '',
          eventTitle: eventTitle || '',
          bookingTitle: bookingTitle || ''
        }
      }
    });

    // 2. Save payment record
    const paymentData = await prisma.payment.create({
      data: {
        uid: uuidv4(),
        app: {
          connect: { slug: "lemonsqueezy" }
        },
        booking: {
          connect: { id: bookingId }
        },
        amount: payment.amount,
        currency: payment.currency,
        externalId: checkout.data.id,
        data: {
          checkout: checkout.data,
          checkoutUrl: checkout.data.attributes.url
        } as unknown as Prisma.InputJsonValue,
        fee: 0,
        refunded: false,
        success: false,
        paymentOption: paymentOption || "ON_BOOKING"
      }
    });

    return paymentData;
  }

  async refund(paymentId: Payment["id"]): Promise<Payment | null> {
    const payment = await this.getPayment({ id: paymentId });
    if (!payment) return null;
    if (!payment.success) throw new Error("Cannot refund unpaid order");
    if (payment.refunded) return payment;

    // Get order ID from payment data
    const orderId = (payment.data as any).order?.id;
    if (!orderId) throw new Error("No order ID found");

    // Issue refund
    await this.client.refundOrder({
      id: orderId,
      amount: payment.amount
    });

    // Update payment record
    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: { refunded: true }
    });

    return updatedPayment;
  }

  async deletePayment(paymentId: Payment["id"]): Promise<boolean> {
    const payment = await this.getPayment({ id: paymentId });
    if (!payment) return false;

    // Lemon Squeezy doesn't support canceling pending checkouts
    // Just mark as deleted in our system
    log.warn("Lemon Squeezy: Cannot cancel checkout, marking as deleted");
    return true;
  }

  // Helper methods...
}

export function BuildPaymentService(credentials: { key: Prisma.JsonValue }): IAbstractPaymentService {
  return new LemonSqueezyPaymentService(credentials);
}
```

### Lemon Squeezy Webhook Handler

```typescript
// apps/web/pages/api/integrations/lemonsqueezypayment/webhook.ts
import { buffer } from "micro";
import type { NextApiRequest, NextApiResponse } from "next";
import crypto from "crypto";
import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import { prisma } from "@calcom/prisma";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  // Get signature from header
  const signature = req.headers["x-signature"] as string;
  if (!signature) {
    return res.status(400).json({ message: "Missing x-signature header" });
  }

  // Read raw body
  const requestBuffer = await buffer(req);
  const payload = requestBuffer.toString();

  // Verify webhook signature
  const isValid = verifyLemonSqueezySignature(
    payload,
    signature,
    process.env.LEMONSQUEEZY_WEBHOOK_SECRET!
  );

  if (!isValid) {
    return res.status(401).json({ message: "Invalid signature" });
  }

  const event = JSON.parse(payload);

  // Handle different event types
  switch (event.meta.event_name) {
    case "order_created":
      await handleOrderCreated(event);
      break;
    case "order_refunded":
      await handleOrderRefunded(event);
      break;
  }

  return res.json({ received: true });
}

async function handleOrderCreated(event: any) {
  const order = event.data;
  const customData = order.attributes.first_order_item.product.custom_data;

  // Find payment by checkout ID (stored in externalId during create)
  const payment = await prisma.payment.findFirst({
    where: {
      // Match on booking ID from custom data
      booking: {
        id: parseInt(customData.bookingId)
      },
      app: {
        slug: "lemonsqueezy"
      }
    },
    select: { id: true, bookingId: true }
  });

  if (!payment?.bookingId) {
    throw new Error("Payment not found");
  }

  // Update payment with order details
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      externalId: order.id,  // Update with order ID
      success: true,
      data: {
        order: order
      } as unknown as Prisma.InputJsonValue
    }
  });

  // Use shared payment success handler
  await handlePaymentSuccess({
    paymentId: payment.id,
    bookingId: payment.bookingId,
    appSlug: "lemonsqueezy",
    traceContext: {}
  });
}

function verifyLemonSqueezySignature(payload: string, signature: string, secret: string): boolean {
  // Lemon Squeezy signature verification
  // See: https://docs.lemonsqueezy.com/api/webhooks#signing-requests
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const digest = hmac.digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(digest)
  );
}
```

### Lemon Squeezy Metadata Configuration

```typescript
// packages/app-store/lemonsqueezypayment/_metadata.ts
import type { AppMeta } from "@calcom/types/App";

export const metadata = {
  name: "Lemon Squeezy",
  description: "Accept payments globally with Lemon Squeezy as your Merchant of Record. Modern payment processing with automatic tax handling.",
  installed: !!(
    process.env.LEMONSQUEEZY_API_KEY &&
    process.env.LEMONSQUEEZY_WEBHOOK_SECRET &&
    process.env.LEMONSQUEEZY_STORE_ID
  ),
  slug: "lemonsqueezy",
  category: "payment",
  categories: ["payment"],
  logo: "icon.svg",
  publisher: "Cal.com",
  title: "Lemon Squeezy",
  type: "lemonsqueezy_payment",
  url: "https://www.lemonsqueezy.com/",
  docsUrl: "https://docs.lemonsqueezy.com/",
  variant: "payment",
  extendsFeature: "EventType",
  email: "help@cal.com",
  dirName: "lemonsqueezypayment",
  isOAuth: false,
} as AppMeta;

export default metadata;
```

### Lemon Squeezy-Specific Challenges & Solutions

#### Challenge 1: Product/Variant setup required

Lemon Squeezy requires creating products in their dashboard first. Unlike Stripe's dynamic pricing, you need a product variant ID.

**Solution**: Support custom pricing on existing variants:

```typescript
const checkout = await this.client.createCheckout({
  storeId: this.credentials.storeId,
  variantId: this.credentials.variantId,  // Set in app config
  customPrice: payment.amount,  // Override variant price
  // ...
});
```

#### Challenge 2: No hold/future payments

Like Paddle, Lemon Squeezy doesn't support collecting payment methods for future charges.

**Solution**: Only support `ON_BOOKING` payment option:

```typescript
async collectCard(): Promise<Payment> {
  throw new Error("Lemon Squeezy does not support hold payments. Use ON_BOOKING payment option only.");
}
```

---

## Implementation Checklist

### Phase 1: Paddle Integration

- [ ] Create app directory structure
  - [ ] `packages/app-store/paddlepayment/`
  - [ ] `_metadata.ts`
  - [ ] `package.json`
  - [ ] `icon.svg` (Paddle logo)

- [ ] Install dependencies
  - [ ] `yarn workspace @calcom/paddlepayment add @paddle/paddle-node-sdk`

- [ ] Implement Payment Service
  - [ ] `lib/server.ts` - Paddle SDK initialization
  - [ ] `lib/customer.ts` - Customer management
  - [ ] `lib/PaymentService.ts` - Full service implementation
  - [ ] `zod.ts` - Validation schemas

- [ ] Implement Webhook Handler
  - [ ] `apps/web/pages/api/integrations/paddlepayment/webhook.ts`
  - [ ] Signature verification
  - [ ] Event handling

- [ ] Environment Variables
  - [ ] Add to `.env.example`:
    ```
    PADDLE_API_KEY=
    PADDLE_WEBHOOK_SECRET=
    PADDLE_ENVIRONMENT=sandbox # or production
    ```

- [ ] Testing
  - [ ] Unit tests for PaymentService
  - [ ] Webhook handler tests
  - [ ] E2E booking flow test with Paddle sandbox

### Phase 2: Lemon Squeezy Integration

- [ ] Create app directory structure
  - [ ] `packages/app-store/lemonsqueezypayment/`
  - [ ] `_metadata.ts`
  - [ ] `package.json`
  - [ ] `icon.svg` (Lemon Squeezy logo)

- [ ] Install dependencies
  - [ ] `yarn workspace @calcom/lemonsqueezypayment add @lemonsqueezy/lemonsqueezy.js`

- [ ] Implement Payment Service
  - [ ] `lib/server.ts` - Lemon Squeezy SDK initialization
  - [ ] `lib/customer.ts` - Customer management
  - [ ] `lib/PaymentService.ts` - Full service implementation
  - [ ] `zod.ts` - Validation schemas

- [ ] Implement Webhook Handler
  - [ ] `apps/web/pages/api/integrations/lemonsqueezypayment/webhook.ts`
  - [ ] Signature verification
  - [ ] Event handling

- [ ] Environment Variables
  - [ ] Add to `.env.example`:
    ```
    LEMONSQUEEZY_API_KEY=
    LEMONSQUEEZY_WEBHOOK_SECRET=
    LEMONSQUEEZY_STORE_ID=
    LEMONSQUEEZY_VARIANT_ID=
    ```

- [ ] Testing
  - [ ] Unit tests for PaymentService
  - [ ] Webhook handler tests
  - [ ] E2E booking flow test

### Phase 3: Documentation & Deployment

- [ ] Update Cal.com documentation
  - [ ] Payment provider setup guide
  - [ ] Webhook configuration instructions
  - [ ] Environment variable reference

- [ ] Terraform Configuration
  - [ ] Add Paddle/Lemon Squeezy env vars to `tf/modules/calcom/main.tf`

- [ ] App Store Registration
  - [ ] Run `yarn app-store-cli` to regenerate app store files
  - [ ] Verify apps appear in Cal.com UI

---

## Environment Variables Reference

### Paddle

```bash
# Paddle API Key (get from https://vendors.paddle.com/authentication)
PADDLE_API_KEY=your_api_key_here

# Webhook secret (get from https://vendors.paddle.com/alerts-webhooks)
PADDLE_WEBHOOK_SECRET=your_webhook_secret

# Environment: 'sandbox' or 'production'
PADDLE_ENVIRONMENT=sandbox
```

### Lemon Squeezy

```bash
# Lemon Squeezy API Key (get from https://app.lemonsqueezy.com/settings/api)
LEMONSQUEEZY_API_KEY=your_api_key_here

# Webhook secret (get from webhook settings)
LEMONSQUEEZY_WEBHOOK_SECRET=your_webhook_secret

# Store ID (found in your store settings)
LEMONSQUEEZY_STORE_ID=your_store_id

# Default variant ID for bookings (create a product first)
LEMONSQUEEZY_VARIANT_ID=your_variant_id
```

---

## User Flow Examples

### Paddle Booking Flow

1. User selects event type with Paddle payment enabled
2. User fills booking form
3. Cal.com creates Paddle transaction via `create()`
4. User redirected to Paddle hosted checkout
5. User completes payment on Paddle
6. Paddle sends webhook to Cal.com
7. Cal.com confirms booking, sends emails
8. User redirected back to success page

### Lemon Squeezy Booking Flow

1. User selects event type with Lemon Squeezy payment enabled
2. User fills booking form
3. Cal.com creates Lemon Squeezy checkout via `create()`
4. User redirected to Lemon Squeezy hosted checkout
5. User completes payment
6. Lemon Squeezy sends `order_created` webhook
7. Cal.com confirms booking, sends emails
8. User redirected back to success page

---

## Key Differences from Stripe

| Feature | Stripe | Paddle | Lemon Squeezy |
|---------|--------|--------|---------------|
| **Checkout** | Embedded or hosted | Hosted only | Hosted only |
| **Hold payments** | ✅ SetupIntent | ❌ Not supported | ❌ Not supported |
| **Tax handling** | Manual (Stripe Tax add-on) | ✅ Automatic (MoR) | ✅ Automatic (MoR) |
| **Fee structure** | 2.9% + $0.30 | 5% + $0.50 | 5% + $0.50 |
| **Refunds** | Full API support | Full API support | Full API support |
| **Currency** | 135+ | 245+ countries | 135+ |
| **Product setup** | Dynamic pricing | Products required | Products required |
| **OAuth** | ✅ Supports Connect | ❌ API keys only | ❌ API keys only |

---

## Migration Considerations

If you're currently using Stripe and want to switch:

### For Existing Bookings

- **Keep Stripe integration** for existing/pending bookings
- New bookings can use Paddle/Lemon Squeezy
- No need to migrate payment history

### For Event Types

- Configure payment provider per event type
- Can have different event types use different providers
- Users see provider selection in event type settings

### Tax Handling

- With Paddle/Lemon Squeezy, you receive **net revenue** after tax
- Provider handles all tax collection and remittance
- Much simpler than Stripe + manual tax compliance

---

## Cost Analysis

At 100,000 bookings/month at $9.99 each:

| Provider | Transaction Cost | Monthly Total |
|----------|-----------------|---------------|
| **Stripe** | 2.9% + $0.30 | $58,971 |
| **Paddle** | 5% + $0.50 | $99,950 |
| **Lemon Squeezy** | 5% + $0.50 | $99,950 |

**But consider:**
- Stripe: + $5,000/month for Stripe Tax
- Stripe: + $3,000/month for accountant
- Stripe: Risk of tax penalties
- **Paddle/LS: All tax handled automatically**

**Effective difference: ~$32k/month** for complete tax peace of mind.

---

## Recommended Approach

1. **Start with Lemon Squeezy** if you value:
   - Modern, developer-friendly API
   - Better documentation than Paddle
   - Active development and support

2. **Choose Paddle** if you need:
   - Maximum global reach (245+ countries)
   - Enterprise support
   - Volume pricing negotiation

3. **Keep Stripe** as an option for:
   - Users who prefer it
   - Markets where Stripe has better local payment methods
   - More control over payment flow

---

## Next Steps

1. **Review this plan** and decide: Paddle, Lemon Squeezy, or both?
2. **Set up sandbox accounts** with chosen provider(s)
3. **Start with Phase 1** implementation
4. **Test thoroughly** in sandbox mode
5. **Deploy to production** once validated

Would you like me to start implementing one of these integrations?
