import type { IncompleteBookingActionType } from "@calcom/prisma/enums";
import type { z } from "zod";

const incompleteBookingActionDataSchemas: Record<IncompleteBookingActionType, z.ZodTypeAny> = {} as Record<
  IncompleteBookingActionType,
  z.ZodTypeAny
>;

export default incompleteBookingActionDataSchemas;
