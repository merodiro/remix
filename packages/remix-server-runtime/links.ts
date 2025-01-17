/**
 * Represents a `<link>` element.
 *
 * WHATWG Specification: https://html.spec.whatwg.org/multipage/semantics.html#the-link-element
 */
export interface HTMLLinkDescriptor {
  /**
   * Address of the hyperlink
   */
  href: string;

  /**
   * How the element handles crossorigin requests
   */
  crossOrigin?: "anonymous" | "use-credentials";

  /**
   * Relationship between the document containing the hyperlink and the destination resource
   */
  rel:
    | "alternate"
    | "dns-prefetch"
    | "icon"
    | "manifest"
    | "modulepreload"
    | "next"
    | "pingback"
    | "preconnect"
    | "prefetch"
    | "preload"
    | "prerender"
    | "search"
    | "stylesheet"
    | string;

  /**
   * Applicable media: "screen", "print", "(max-width: 764px)"
   */
  media?: string;

  /**
   * Integrity metadata used in Subresource Integrity checks
   */
  integrity?: string;

  /**
   * Language of the linked resource
   */
  hrefLang?: string;

  /**
   * Hint for the type of the referenced resource
   */
  type?: string;

  /**
   * Referrer policy for fetches initiated by the element
   */
  referrerPolicy?:
    | ""
    | "no-referrer"
    | "no-referrer-when-downgrade"
    | "same-origin"
    | "origin"
    | "strict-origin"
    | "origin-when-cross-origin"
    | "strict-origin-when-cross-origin"
    | "unsafe-url";

  /**
   * Sizes of the icons (for rel="icon")
   */
  sizes?: string;

  /**
   * Images to use in different situations, e.g., high-resolution displays, small monitors, etc. (for rel="preload")
   */
  imagesrcset?: string;

  /**
   * Image sizes for different page layouts (for rel="preload")
   */
  imagesizes?: string;

  /**
   * Potential destination for a preload request (for rel="preload" and rel="modulepreload")
   */
  as?:
    | "audio"
    | "audioworklet"
    | "document"
    | "embed"
    | "fetch"
    | "font"
    | "frame"
    | "iframe"
    | "image"
    | "manifest"
    | "object"
    | "paintworklet"
    | "report"
    | "script"
    | "serviceworker"
    | "sharedworker"
    | "style"
    | "track"
    | "video"
    | "worker"
    | "xslt"
    | string;

  /**
   * Color to use when customizing a site's icon (for rel="mask-icon")
   */
  color?: string;

  /**
   * Whether the link is disabled
   */
  disabled?: boolean;

  /**
   * The title attribute has special semantics on this element: Title of the link; CSS style sheet set name.
   */
  title?: string;
}

export interface PageLinkDescriptor
  extends Omit<
    HTMLLinkDescriptor,
    | "href"
    | "rel"
    | "type"
    | "sizes"
    | "imagesrcset"
    | "imagesizes"
    | "as"
    | "color"
    | "title"
  > {
  /**
   * The absolute path of the page to prefetch.
   */
  page: string;
}

export type LinkDescriptor = HTMLLinkDescriptor | PageLinkDescriptor;
