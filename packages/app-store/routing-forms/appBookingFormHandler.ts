import type { AttributeRoutingConfig } from "./types/types";

type AppBookingFormHandler = (
  attendeeEmail: string,
  attributeRoutingConfig: AttributeRoutingConfig,
  eventTypeId: number
) => Promise<{ email: string | null; recordType: string | null; recordId: string | null }>;

const appBookingFormHandler: Record<string, AppBookingFormHandler> = {};

export default appBookingFormHandler;
