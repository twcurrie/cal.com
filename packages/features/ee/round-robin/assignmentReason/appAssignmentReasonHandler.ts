import type { AssignmentReasonEnum } from "@calcom/prisma/enums";

type AppAssignmentReasonHandler = ({
  recordType,
  teamMemberEmail,
  routingFormResponseId,
  recordId,
}: {
  recordType: string;
  teamMemberEmail: string;
  routingFormResponseId: number;
  recordId?: string;
}) => Promise<{ assignmentReason: string | undefined; reasonEnum: AssignmentReasonEnum } | undefined>;

const appBookingFormHandler: Record<string, AppAssignmentReasonHandler> = {};

export default appBookingFormHandler;
