import type { AppLoadContext } from "./data";
import { extractData, isCatchResponse } from "./data";
import { loadRouteData, callRouteAction, isRedirectResponse } from "./data";
import type { ComponentDidCatchEmulator } from "./errors";
import type { ServerBuild } from "./build";
import type { EntryContext } from "./entry";
import { createEntryMatches, createEntryRouteModules } from "./entry";
import { serializeError } from "./errors";
import { getDocumentHeaders } from "./headers";
import type { ServerPlatform } from "./platform";
import type { RouteMatch } from "./routeMatching";
import { matchServerRoutes } from "./routeMatching";
import { ServerMode, isServerMode } from "./mode";
import type { ServerRoute } from "./routes";
import { createRoutes } from "./routes";
import { createActionData, createRouteData } from "./routeData";
import { json } from "./responses";
import { createServerHandoffString } from "./serverHandoff";

/**
 * The main request handler for a Remix server. This handler runs in the context
 * of a cloud provider's server (e.g. Express on Firebase) or locally via their
 * dev tools.
 */
export interface RequestHandler {
  (request: Request, loadContext?: AppLoadContext): Promise<Response>;
}

type RequestType = "data" | "document" | "resource";

function getRequestType(
  request: Request,
  matches: RouteMatch<ServerRoute>[] | null
): RequestType {
  if (isDataRequest(request)) {
    return "data";
  }

  if (!matches) {
    return "document";
  }

  let match = matches.slice(-1)[0];
  if (!match.route.module.default) {
    return "resource";
  }

  return "document";
}

/**
 * Creates a function that serves HTTP requests.
 */
export function createRequestHandler(
  build: ServerBuild,
  platform: ServerPlatform,
  mode?: string
): RequestHandler {
  let routes = createRoutes(build.routes);
  let serverMode = isServerMode(mode) ? mode : ServerMode.Production;

  return async (request, loadContext = {}) => {
    let url = new URL(request.url);
    let matches = matchServerRoutes(routes, url.pathname);

    let requestType = getRequestType(request, matches);

    let response: Response;

    switch (requestType) {
      // has _data
      case "data":
        response = await handleDataRequest(
          request,
          loadContext,
          build,
          platform,
          matches
        );
        break;
      // no _data & default export
      case "document":
        response = await handleDocumentRequest(
          request,
          loadContext,
          build,
          platform,
          routes,
          serverMode
        );
        break;
      // no _data  or default export
      case "resource":
        response = await handleResourceRequest(
          request,
          loadContext,
          build,
          platform,
          matches
        );
        break;
    }

    if (isHeadRequest(request)) {
      return new Response(null, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText
      });
    }

    return response;
  };
}

async function handleResourceRequest(
  request: Request,
  loadContext: AppLoadContext,
  build: ServerBuild,
  platform: ServerPlatform,
  matches: RouteMatch<ServerRoute>[] | null
): Promise<Response> {
  let url = new URL(request.url);

  if (!matches) {
    return jsonError(`No route matches URL "${url.pathname}"`, 404);
  }

  let routeMatch: RouteMatch<ServerRoute> = matches.slice(-1)[0];
  try {
    return isActionRequest(request)
      ? await callRouteAction(
          build,
          routeMatch.route.id,
          request,
          loadContext,
          routeMatch.params
        )
      : await loadRouteData(
          build,
          routeMatch.route.id,
          request,
          loadContext,
          routeMatch.params
        );
  } catch (error: any) {
    let formattedError = (await platform.formatServerError?.(error)) || error;
    throw formattedError;
  }
}

async function handleDataRequest(
  request: Request,
  loadContext: AppLoadContext,
  build: ServerBuild,
  platform: ServerPlatform,
  matches: RouteMatch<ServerRoute>[] | null
): Promise<Response> {
  if (!isValidRequestMethod(request)) {
    return jsonError(`Invalid request method "${request.method}"`, 405);
  }

  let url = new URL(request.url);

  if (!matches) {
    return jsonError(`No route matches URL "${url.pathname}"`, 404);
  }

  let routeMatch: RouteMatch<ServerRoute>;
  if (isActionRequest(request)) {
    routeMatch = matches[matches.length - 1];

    if (
      !isIndexRequestUrl(url) &&
      matches[matches.length - 1].route.id.endsWith("/index")
    ) {
      routeMatch = matches[matches.length - 2];
    }
  } else {
    let routeId = url.searchParams.get("_data");
    if (!routeId) {
      return jsonError(`Missing route id in ?_data`, 403);
    }

    let match = matches.find(match => match.route.id === routeId);
    if (!match) {
      return jsonError(
        `Route "${routeId}" does not match URL "${url.pathname}"`,
        403
      );
    }

    routeMatch = match;
  }

  let clonedRequest = stripIndexParam(stripDataParam(request));

  let response: Response;
  try {
    response = isActionRequest(request)
      ? await callRouteAction(
          build,
          routeMatch.route.id,
          clonedRequest,
          loadContext,
          routeMatch.params
        )
      : await loadRouteData(
          build,
          routeMatch.route.id,
          clonedRequest,
          loadContext,
          routeMatch.params
        );
  } catch (error: any) {
    let formattedError = (await platform.formatServerError?.(error)) || error;
    response = json(await serializeError(formattedError), {
      status: 500,
      headers: {
        "X-Remix-Error": "unfortunately, yes"
      }
    });
  }

  if (isRedirectResponse(response)) {
    // We don't have any way to prevent a fetch request from following
    // redirects. So we use the `X-Remix-Redirect` header to indicate the
    // next URL, and then "follow" the redirect manually on the client.
    let headers = new Headers(response.headers);
    headers.set("X-Remix-Redirect", headers.get("Location")!);
    headers.delete("Location");

    return new Response("", {
      status: 204,
      headers
    });
  }

  if (build.entry.module.handleDataRequest) {
    clonedRequest = stripIndexParam(stripDataParam(request));
    return build.entry.module.handleDataRequest(response, {
      request: clonedRequest,
      context: loadContext,
      params: routeMatch.params
    });
  }

  return response;
}

async function handleDocumentRequest(
  request: Request,
  loadContext: AppLoadContext,
  build: ServerBuild,
  platform: ServerPlatform,
  routes: ServerRoute[],
  serverMode: ServerMode
): Promise<Response> {
  let url = new URL(request.url);

  let requestState: "ok" | "no-match" | "invalid-request" =
    isValidRequestMethod(request) ? "ok" : "invalid-request";
  let matches =
    requestState === "ok" ? matchServerRoutes(routes, url.pathname) : null;

  if (!matches) {
    // If we do not match a user-provided-route, fall back to the root
    // to allow the CatchBoundary to take over while maintining invalid
    // request state if already set
    if (requestState === "ok") {
      requestState = "no-match";
    }

    matches = [
      {
        params: {},
        pathname: "",
        route: routes[0]
      }
    ];
  }

  let componentDidCatchEmulator: ComponentDidCatchEmulator = {
    trackBoundaries: true,
    trackCatchBoundaries: true,
    catchBoundaryRouteId: null,
    renderBoundaryRouteId: null,
    loaderBoundaryRouteId: null,
    error: undefined,
    catch: undefined
  };

  let responseState: "ok" | "caught" | "error" = "ok";
  let actionResponse: Response | undefined;
  let actionRouteId: string | undefined;

  if (requestState !== "ok") {
    responseState = "caught";
    componentDidCatchEmulator.trackCatchBoundaries = false;
    let withBoundaries = getMatchesUpToDeepestBoundary(
      matches,
      "CatchBoundary"
    );
    componentDidCatchEmulator.catchBoundaryRouteId =
      withBoundaries.length > 0
        ? withBoundaries[withBoundaries.length - 1].route.id
        : null;
    componentDidCatchEmulator.catch = {
      status: requestState === "no-match" ? 404 : 405,
      statusText:
        requestState === "no-match" ? "Not Found" : "Method Not Allowed",
      data: null
    };
  } else if (isActionRequest(request)) {
    let actionMatch = matches[matches.length - 1];
    if (!isIndexRequestUrl(url) && actionMatch.route.id.endsWith("/index")) {
      actionMatch = matches[matches.length - 2];
    }
    actionRouteId = actionMatch.route.id;

    try {
      let clonedRequest = stripIndexParam(stripDataParam(request));

      actionResponse = await callRouteAction(
        build,
        actionMatch.route.id,
        clonedRequest,
        loadContext,
        actionMatch.params
      );
      if (isRedirectResponse(actionResponse)) {
        return actionResponse;
      }
    } catch (error: any) {
      let formattedError = (await platform.formatServerError?.(error)) || error;
      responseState = "error";
      let withBoundaries = getMatchesUpToDeepestBoundary(
        matches,
        "ErrorBoundary"
      );
      componentDidCatchEmulator.loaderBoundaryRouteId =
        withBoundaries[withBoundaries.length - 1].route.id;
      componentDidCatchEmulator.error = await serializeError(formattedError);
    }
  }

  if (actionResponse && isCatchResponse(actionResponse)) {
    responseState = "caught";
    let withBoundaries = getMatchesUpToDeepestBoundary(
      matches,
      "CatchBoundary"
    );
    componentDidCatchEmulator.trackCatchBoundaries = false;
    componentDidCatchEmulator.catchBoundaryRouteId =
      withBoundaries[withBoundaries.length - 1].route.id;
    componentDidCatchEmulator.catch = {
      status: actionResponse.status,
      statusText: actionResponse.statusText,
      data: await extractData(actionResponse.clone())
    };
  }

  // If we did not match a route, there is no need to call any loaders
  let matchesToLoad = requestState !== "ok" ? [] : matches;
  switch (responseState) {
    case "caught":
      matchesToLoad = getMatchesUpToDeepestBoundary(
        // get rid of the action, we don't want to call it's loader either
        // because we'll be rendering the catch boundary, if you can get access
        // to the loader data in the catch boundary then how the heck is it
        // supposed to deal with thrown responses?
        matches.slice(0, -1),
        "CatchBoundary"
      );
      break;
    case "error":
      matchesToLoad = getMatchesUpToDeepestBoundary(
        // get rid of the action, we don't want to call it's loader either
        // because we'll be rendering the error boundary, if you can get access
        // to the loader data in the error boundary then how the heck is it
        // supposed to deal with errors in the loader, too?
        matches.slice(0, -1),
        "ErrorBoundary"
      );
      break;
  }

  // Run all data loaders in parallel. Await them in series below.  Note: This
  // code is a little weird due to the way unhandled promise rejections are
  // handled in node. We use a .catch() handler on each promise to avoid the
  // warning, then handle errors manually afterwards.
  let routeLoaderPromises: Promise<Response | Error>[] = matchesToLoad.map(
    match =>
      loadRouteData(
        build,
        match.route.id,
        stripIndexParam(stripDataParam(request.clone())),
        loadContext,
        match.params
      ).catch(error => error)
  );

  let routeLoaderResults = await Promise.all(routeLoaderPromises);
  for (let [index, response] of routeLoaderResults.entries()) {
    let route = matches[index].route;
    let routeModule = build.routes[route.id].module;

    // Rare case where an action throws an error, and then when we try to render
    // the action's page to tell the user about the the error, a loader above
    // the action route *also* threw an error or tried to redirect!
    //
    // Instead of rendering the loader error or redirecting like usual, we
    // ignore the loader error or redirect because the action error was first
    // and is higher priority to surface.  Perhaps the action error is the
    // reason the loader blows up now! It happened first and is more important
    // to address.
    //
    // We just give up and move on with rendering the error as deeply as we can,
    // which is the previous iteration of this loop
    if (
      (responseState === "error" &&
        (response instanceof Error || isRedirectResponse(response))) ||
      (responseState === "caught" && isCatchResponse(response))
    ) {
      break;
    }

    if (componentDidCatchEmulator.catch || componentDidCatchEmulator.error) {
      continue;
    }

    if (routeModule.CatchBoundary) {
      componentDidCatchEmulator.catchBoundaryRouteId = route.id;
    }

    if (routeModule.ErrorBoundary) {
      componentDidCatchEmulator.loaderBoundaryRouteId = route.id;
    }

    if (response instanceof Error) {
      if (serverMode !== ServerMode.Test) {
        console.error(
          `There was an error running the data loader for route ${route.id}`
        );
      }

      let formattedError =
        (await platform.formatServerError?.(response)) || response;

      componentDidCatchEmulator.error = await serializeError(formattedError);
      routeLoaderResults[index] = json(null, { status: 500 });
    } else if (isRedirectResponse(response)) {
      return response;
    } else if (isCatchResponse(response)) {
      componentDidCatchEmulator.trackCatchBoundaries = false;
      componentDidCatchEmulator.catch = {
        status: response.status,
        statusText: response.statusText,
        data: await extractData(response.clone())
      };
      routeLoaderResults[index] = json(null, { status: response.status });
    }
  }

  // We already filtered out all Errors, so these are all Responses.
  let routeLoaderResponses: Response[] = routeLoaderResults as Response[];

  // Handle responses with a non-200 status code. The first loader with a
  // non-200 status code determines the status code for the whole response.
  let notOkResponse = [actionResponse, ...routeLoaderResponses].find(
    response => response && response.status !== 200
  );

  let statusCode =
    requestState === "no-match"
      ? 404
      : requestState === "invalid-request"
      ? 405
      : responseState === "error"
      ? 500
      : notOkResponse
      ? notOkResponse.status
      : 200;

  let renderableMatches = getRenderableMatches(
    matches,
    componentDidCatchEmulator
  );
  let serverEntryModule = build.entry.module;
  let headers = getDocumentHeaders(
    build,
    renderableMatches,
    routeLoaderResponses,
    actionResponse
  );
  let entryMatches = createEntryMatches(renderableMatches, build.assets.routes);
  let routeData = await createRouteData(
    renderableMatches,
    routeLoaderResponses
  );
  let actionData =
    actionResponse && actionRouteId
      ? {
          [actionRouteId]: await createActionData(actionResponse)
        }
      : undefined;
  let routeModules = createEntryRouteModules(build.routes);
  let serverHandoff = {
    matches: entryMatches,
    componentDidCatchEmulator,
    routeData,
    actionData
  };
  let entryContext: EntryContext = {
    ...serverHandoff,
    manifest: build.assets,
    routeModules,
    serverHandoffString: createServerHandoffString(serverHandoff)
  };

  let response: Response | Promise<Response>;
  try {
    response = serverEntryModule.default(
      request,
      statusCode,
      headers,
      entryContext
    );
  } catch (error: any) {
    let formattedError = (await platform.formatServerError?.(error)) || error;
    if (serverMode !== ServerMode.Test) {
      console.error(formattedError);
    }

    statusCode = 500;

    // Go again, this time with the componentDidCatch emulation. As it rendered
    // last time we mutated `componentDidCatch.routeId` for the last rendered
    // route, now we know where to render the error boundary (feels a little
    // hacky but that's how hooks work). This tells the emulator to stop
    // tracking the `routeId` as we render because we already have an error to
    // render.
    componentDidCatchEmulator.trackBoundaries = false;
    componentDidCatchEmulator.error = await serializeError(formattedError);
    entryContext.serverHandoffString = createServerHandoffString(serverHandoff);

    try {
      response = serverEntryModule.default(
        request,
        statusCode,
        headers,
        entryContext
      );
    } catch (error: any) {
      let formattedError = (await platform.formatServerError?.(error)) || error;
      if (serverMode !== ServerMode.Test) {
        console.error(formattedError);
      }

      // Good grief folks, get your act together 😂!
      response = new Response(
        `Unexpected Server Error\n\n${formattedError.message}`,
        {
          status: 500,
          headers: {
            "Content-Type": "text/plain"
          }
        }
      );
    }
  }

  return response;
}

function jsonError(error: string, status = 403): Response {
  return json({ error }, { status });
}

function isActionRequest(request: Request): boolean {
  let method = request.method.toLowerCase();
  return (
    method === "post" ||
    method === "put" ||
    method === "patch" ||
    method === "delete"
  );
}

function isValidRequestMethod(request: Request): boolean {
  return (
    request.method.toLowerCase() === "get" ||
    isHeadRequest(request) ||
    isActionRequest(request)
  );
}

function isHeadRequest(request: Request): boolean {
  return request.method.toLowerCase() === "head";
}

function isDataRequest(request: Request): boolean {
  return new URL(request.url).searchParams.has("_data");
}

function isIndexRequestUrl(url: URL) {
  let indexRequest = false;

  for (let param of url.searchParams.getAll("index")) {
    if (!param) {
      indexRequest = true;
    }
  }

  return indexRequest;
}

function stripIndexParam(request: Request) {
  let url = new URL(request.url);
  let indexValues = url.searchParams.getAll("index");
  url.searchParams.delete("index");
  let indexValuesToKeep = [];
  for (let indexValue of indexValues) {
    if (indexValue) {
      indexValuesToKeep.push(indexValue);
    }
  }
  for (let toKeep of indexValuesToKeep) {
    url.searchParams.append("index", toKeep);
  }

  return new Request(url.toString(), request);
}

function stripDataParam(request: Request) {
  let url = new URL(request.url);
  url.searchParams.delete("_data");
  return new Request(url.toString(), request);
}

// TODO: update to use key for lookup
function getMatchesUpToDeepestBoundary(
  matches: RouteMatch<ServerRoute>[],
  key: "CatchBoundary" | "ErrorBoundary"
) {
  let deepestBoundaryIndex: number = -1;

  matches.forEach((match, index) => {
    if (match.route.module[key]) {
      deepestBoundaryIndex = index;
    }
  });

  if (deepestBoundaryIndex === -1) {
    // no route error boundaries, don't need to call any loaders
    return [];
  }

  return matches.slice(0, deepestBoundaryIndex + 1);
}

// This prevents `<Outlet/>` from rendering anything below where the error threw
// TODO: maybe do this in <RemixErrorBoundary + context>
function getRenderableMatches(
  matches: RouteMatch<ServerRoute>[],
  componentDidCatchEmulator: ComponentDidCatchEmulator
) {
  // no error, no worries
  if (!componentDidCatchEmulator.catch && !componentDidCatchEmulator.error) {
    return matches;
  }

  let lastRenderableIndex: number = -1;

  matches.forEach((match, index) => {
    let id = match.route.id;
    if (
      componentDidCatchEmulator.renderBoundaryRouteId === id ||
      componentDidCatchEmulator.loaderBoundaryRouteId === id ||
      componentDidCatchEmulator.catchBoundaryRouteId === id
    ) {
      lastRenderableIndex = index;
    }
  });

  return matches.slice(0, lastRenderableIndex + 1);
}
