import type { App_RoutingForms_IncompleteBookingActions } from "@calcom/prisma/client";
import type { IncompleteBookingActionType } from "@calcom/prisma/enums";

const incompleteBookingActionFunctions: Record<
  IncompleteBookingActionType,
  (action: App_RoutingForms_IncompleteBookingActions, email: string) => void
> = {} as Record<
  IncompleteBookingActionType,
  (action: App_RoutingForms_IncompleteBookingActions, email: string) => void
>;

export default incompleteBookingActionFunctions;
