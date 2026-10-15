import { z } from "zod";

/** Identity of a versioned Workflow document, shared by hosts and the Workflows App. */
export const workflowIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
