const GLOBE = "M-6,0 A6,6 0 1 0 6,0 A6,6 0 1 0 -6,0 M-6,0 L6,0 M0,-6 Q-4,0 0,6 M0,-6 Q4,0 0,6";

/** Icons for infrastructure node kinds (14×14, centred on 0,0), shared by both views. */
export const INFRA_ICONS: Record<string, string> = {
  database:
    "M-5,-4 A5,2 0 1 0 5,-4 A5,2 0 1 0 -5,-4 L-5,4 A5,2 0 0 0 5,4 L5,-4 M-5,0 A5,2 0 0 0 5,0",
  cache: "M1,-7 L-4,1 L0,1 L-1,7 L4,-1 L0,-1 Z",
  compute: "M-6,-5 L6,-5 L6,-1 L-6,-1 Z M-6,1 L6,1 L6,5 L-6,5 Z M-4,-3 L-2,-3 M-4,3 L-2,3",
  queue: "M-6,-4 L4,-4 M-6,0 L4,0 M-6,4 L4,4 M2,-6.5 L5,-4 L2,-1.5",
  storage: "M-6,-4 L6,-4 L4,6 L-4,6 Z M-6,-4 A6,2 0 0 1 6,-4",
  hosting: GLOBE,
  cdn: GLOBE,
  email: "M-6,-4 L6,-4 L6,4 L-6,4 Z M-6,-4 L0,1 L6,-4",
  payments: "M-6,-4 L6,-4 L6,4 L-6,4 Z M-6,-1 L6,-1 M-4,2 L-1,2",
  llm: "M0,-7 L1.5,-1.5 L7,0 L1.5,1.5 L0,7 L-1.5,1.5 L-7,0 L-1.5,-1.5 Z",
  messaging: "M-6,-5 L6,-5 L6,3 L-1,3 L-4,6 L-4,3 L-6,3 Z",
  search: "M-6,-2 A4,4 0 1 0 2,-2 A4,4 0 1 0 -6,-2 M1,1 L6,6",
  auth: "M-5,-1 L5,-1 L5,6 L-5,6 Z M-3,-1 L-3,-3 A3,3 0 0 1 3,-3 L3,-1",
};
