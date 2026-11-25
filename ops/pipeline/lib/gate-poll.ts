// How long the live gateway gates wait for a rolling deployment to show: 20 tries, 15 s apart (5 minutes). The gateway step already waited for CloudFormation.
export const ATTEMPTS = 20;
export const WAIT_MS = 15_000;
