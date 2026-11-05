// The custom domain parameters' allowed patterns, shared by the control-plane stack (custom-domain.ts) and the access stack (access.ts), which must accept the same values.
/** A lower-case DNS name of at least two labels, or empty. */
export const CUSTOM_DOMAIN_NAME_PATTERN = "^$|^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$";
/** A Route 53 hosted zone id, or empty. */
export const CUSTOM_DOMAIN_ZONE_PATTERN = "^$|^Z[A-Z0-9]{4,31}$";
