import { Resend } from "resend";

export interface EmailAlert {
  to: string;
  productTitle: string;
  merchant: string;
  url: string;
  observedPrice: number;
  targetPrice: number;
  observedAt: string;
}

export interface SendResult {
  sent: boolean;
  error?: string;
}

export interface Notifier {
  readonly available: boolean;
  sendAlert(input: EmailAlert): Promise<SendResult>;
}

function formatBody(input: EmailAlert): string {
  const diff = input.targetPrice - input.observedPrice;
  return [
    `Wisora price alert`,
    ``,
    `Product: ${input.productTitle}`,
    `Merchant: ${input.merchant}`,
    `Observed price: ₹${input.observedPrice.toLocaleString("en-IN")}`,
    `Your target: ₹${input.targetPrice.toLocaleString("en-IN")}`,
    `Difference: ₹${diff.toLocaleString("en-IN")} below target`,
    `Observed at: ${input.observedAt}`,
    `Link: ${input.url}`,
    ``,
    `Prices change quickly and availability is not guaranteed — this alert ` +
      `reflects a single verified observation, not a promise you can buy at ` +
      `this price.`,
  ].join("\n");
}

export class ResendNotifier implements Notifier {
  readonly available = true;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async sendAlert(input: EmailAlert): Promise<SendResult> {
    try {
      const resend = new Resend(this.apiKey);
      const { error } = await resend.emails.send({
        from: this.from,
        to: input.to,
        subject:
          `Price alert: ${input.productTitle} at ` +
          `₹${input.observedPrice.toLocaleString("en-IN")} ` +
          `(target ₹${input.targetPrice.toLocaleString("en-IN")})`,
        text: formatBody(input),
      });
      if (error) {
        return { sent: false, error: error.message.slice(0, 300) };
      }
      return { sent: true };
    } catch (error) {
      return {
        sent: false,
        error:
          error instanceof Error
            ? error.message.slice(0, 300)
            : "Email send failed.",
      };
    }
  }
}

export class UnavailableNotifier implements Notifier {
  readonly available = false;

  async sendAlert(): Promise<SendResult> {
    return {
      sent: false,
      error:
        "Email is not configured (RESEND_API_KEY and RESEND_FROM are required).",
    };
  }
}

export function notifierFromEnv(): Notifier {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    return new UnavailableNotifier();
  }
  return new ResendNotifier(apiKey, from);
}
