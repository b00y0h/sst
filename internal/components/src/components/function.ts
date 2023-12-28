import fs from "fs";
import path from "path";
import crypto from "crypto";
import archiver from "archiver";
import type { Loader, BuildOptions } from "esbuild";
import {
  Input,
  Output,
  ComponentResource,
  ComponentResourceOptions,
  asset,
  output,
  all,
  interpolate,
} from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { FunctionCodeUpdater } from "./providers/function-code-updater.js";
import { AWS } from "./helpers/aws.js";
import { LogGroup } from "./providers/log-group.js";
import { Duration, toSeconds } from "./util/duration.js";
import { Size, toMBs } from "./util/size.js";
import { Component } from "./component.js";

const RETENTION = {
  "1 day": 1,
  "3 days": 3,
  "5 days": 5,
  "1 week": 7,
  "2 weeks": 14,
  "1 month": 30,
  "2 months": 60,
  "3 months": 90,
  "4 months": 120,
  "5 months": 150,
  "6 months": 180,
  "1 year": 365,
  "13 months": 400,
  "18 months": 545,
  "2 years": 731,
  "3 years": 1096,
  "5 years": 1827,
  "6 years": 2192,
  "7 years": 2557,
  "8 years": 2922,
  "9 years": 3288,
  "10 years": 3653,
  forever: 0,
};

export interface FunctionNodeJSArgs {
  /**
   * Configure additional esbuild loaders for other file extensions
   *
   * @example
   * ```js
   * nodejs: {
   *   loader: {
   *    ".png": "file"
   *   }
   * }
   * ```
   */
  loader?: Input<Record<string, Loader>>;

  /**
   * Packages that will be excluded from the bundle and installed into node_modules instead. Useful for dependencies that cannot be bundled, like those with binary dependencies.
   *
   * @example
   * ```js
   * nodejs: {
   *   install: ["pg"]
   * }
   * ```
   */
  install?: Input<string[]>;

  /**
   * Use this to insert an arbitrary string at the beginning of generated JavaScript and CSS files.
   *
   * @example
   * ```js
   * nodejs: {
   *   banner: "console.log('Function starting')"
   * }
   * ```
   */
  banner?: Input<string>;

  /**
   * This allows you to customize esbuild config.
   */
  esbuild?: Input<BuildOptions>;

  /**
   * Enable or disable minification
   *
   * @default true
   *
   * @example
   * ```js
   * nodejs: {
   *   minify: false
   * }
   * ```
   */
  minify?: Input<boolean>;
  /**
   * Configure format
   *
   * @default "esm"
   *
   * @example
   * ```js
   * nodejs: {
   *   format: "cjs"
   * }
   * ```
   */
  format?: Input<"cjs" | "esm">;
  /**
   * Configure if sourcemaps are generated when the function is bundled for production. Since they increase payload size and potentially cold starts they are not generated by default. They are always generated during local development mode.
   *
   * @default false
   *
   * @example
   * ```js
   * nodejs: {
   *   sourcemap: true
   * }
   * ```
   */
  sourcemap?: Input<boolean>;

  /**
   * If enabled, modules that are dynamically imported will be bundled as their own files with common dependencies placed in shared chunks. This can help drastically reduce cold starts as your function grows in size.
   *
   * @default false
   *
   * @example
   * ```js
   * nodejs: {
   *   splitting: true
   * }
   * ```
   */
  splitting?: Input<boolean>;
}

export interface FunctionUrlCorsArgs
  extends Omit<
    aws.types.input.lambda.FunctionUrlCors,
    "allowMethods" | "maxAge"
  > {
  /**
   * The HTTP methods that are allowed when calling the function URL. For example: `["GET", "POST", "DELETE"]`, or the wildcard character (`["*"]`).
   */
  allowMethods?: Input<
    Input<
      "*" | "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT"
    >[]
  >;
  /**
   * The maximum amount of time, in seconds, that web browsers can cache results of a preflight request. By default, this is set to `0`, which means that the browser doesn't cache results. The maximum value is `86400`.
   */
  maxAge?: Input<Duration>;
}
export interface FunctionUrlArgs {
  /**
   * The authorization for the function URL
   * @default "none"
   * @example
   * ```js
   * {
   *   url: {
   *     authorization: "iam",
   *   },
   * }
   * ```
   */
  authorization?: Input<"none" | "iam">;
  /**
   * CORS support for the function URL
   * @default true
   * @example
   * ```js
   * {
   *   url: {
   *     cors: true,
   *   },
   * }
   * ```
   *
   * ```js
   * {
   *   url: {
   *     cors: {
   *       allowedMethods: ["GET", "POST"],
   *       allowedOrigins: ['https://example.com'],
   *     },
   *   },
   * }
   * ```
   */
  cors?: Input<boolean | FunctionUrlCorsArgs>;
}

export interface FunctionLoggingArgs {
  /**
   * The duration function logs are kept in CloudWatch Logs.
   *
   * When updating this property, unsetting it doesn't retain the logs indefinitely. Explicitly set the value to "forever".
   * @default Logs retained indefinitely
   * @example
   * ```js
   * {
   *   logging: {
   *     retention: "1 week"
   *   }
   * }
   * ```
   */
  retention?: Input<keyof typeof RETENTION>;
}

export interface FunctionArgs {
  description?: Input<string>;
  runtime?: Input<"nodejs18.x" | "nodejs20.x">;
  bundle: Input<string>;
  bundleHash?: Input<string>;
  handler: Input<string>;
  timeout?: Input<Duration>;
  memory?: Input<Size>;
  environment?: Input<Record<string, Input<string>>>;
  policies?: Input<aws.types.input.iam.RoleInlinePolicy[]>;
  bind?: Input<ComponentResource>;
  streaming?: Input<boolean>;
  injections?: Input<string[]>;
  logging?: Input<FunctionLoggingArgs>;
  architecture?: Input<"x86_64" | "arm64">;
  /**
   * Enable function URLs, a dedicated endpoint for your Lambda function.
   * @default Disabled
   * @example
   * ```js
   * {
   *   url: true
   * }
   * ```
   *
   * ```js
   * {
   *   url: {
   *     authorization: "iam",
   *     cors: {
   *       allowedOrigins: ['https://example.com'],
   *     }
   *   }
   * }
   * ```
   */
  url?: Input<boolean | FunctionUrlArgs>;
  /**
   * Used to configure nodejs function properties
   */
  nodejs?: Input<FunctionNodeJSArgs>;
  nodes?: {
    function?: Omit<aws.lambda.FunctionArgs, "role">;
  };
}

export class Function extends Component {
  private function: Output<aws.lambda.Function>;
  private role: aws.iam.Role;
  private logGroup: LogGroup;
  private fnUrl: Output<aws.lambda.FunctionUrl | undefined>;
  private missingSourcemap?: boolean;

  constructor(
    name: string,
    args: FunctionArgs,
    opts?: ComponentResourceOptions
  ) {
    super("sst:sst:Function", name, args, opts);

    const parent = this;
    const region = normalizeRegion();
    const injections = normalizeInjections();
    const runtime = normalizeRuntime();
    const timeout = normalizeTimeout();
    const memory = normalizeMemory();
    const architectures = normalizeArchitectures();
    const environment = normalizeEnvironment();
    const streaming = normalizeStreaming();
    const logging = normalizeLogging();
    const url = normalizeUrl();

    const bindInjection = bind();
    const newHandler = wrapHandler();
    const role = createRole();
    const zipPath = zipBundleFolder();
    const bundleHash = args.bundleHash ?? calculateHash();
    const file = createBucketObject();
    const fnRaw = createFunction();
    const fn = updateFunctionCode();

    const logGroup = createLogGroup();
    const fnUrl = createUrl();

    this.function = fn;
    this.role = role;
    this.fnUrl = fnUrl;
    this.logGroup = logGroup;

    function normalizeRegion() {
      return all([
        $app.providers?.aws?.region!,
        (opts?.provider as aws.Provider)?.region,
      ]).apply(([appRegion, region]) => region ?? appRegion);
    }

    function normalizeInjections() {
      return output(args.injections).apply((injections) => injections ?? []);
    }

    function normalizeRuntime() {
      return output(args.runtime).apply((v) => v ?? "nodejs18.x");
    }

    function normalizeTimeout() {
      return output(args.timeout).apply((timeout) => timeout ?? "20 seconds");
    }

    function normalizeMemory() {
      return output(args.memory).apply((memory) => memory ?? "1024 MB");
    }

    function normalizeArchitectures() {
      return output(args.architecture).apply((arc) =>
        arc === "arm64" ? ["arm64"] : ["x86_64"]
      );
    }

    function normalizeEnvironment() {
      return output(args.environment).apply((environment) => environment ?? {});
    }

    function normalizeStreaming() {
      return output(args.streaming).apply((streaming) => streaming ?? false);
    }

    function normalizeLogging() {
      return output(args.logging).apply((logging) => ({
        ...logging,
        retention: logging?.retention ?? "forever",
      }));
    }

    function normalizeUrl() {
      return output(args.url).apply((url) => {
        if (url === false || url === undefined) return;
        if (url === true) {
          url = {};
        }

        // normalize authorization
        const defaultAuthorization = "none" as const;
        const authorization = url.authorization ?? defaultAuthorization;

        // normalize cors
        const defaultCors: aws.types.input.lambda.FunctionUrlCors = {
          allowHeaders: ["*"],
          allowMethods: ["*"],
          allowOrigins: ["*"],
        };
        const cors =
          url.cors === false
            ? {}
            : url.cors === true || url.cors === undefined
              ? defaultCors
              : {
                  ...defaultCors,
                  ...url.cors,
                  maxAge: url.cors.maxAge && toSeconds(url.cors.maxAge),
                };

        return { authorization, cors };
      });
    }

    function calculateHash() {
      return zipPath.apply(async (zipPath) => {
        const hash = crypto.createHash("sha256");
        hash.update(await fs.promises.readFile(zipPath));
        return hash.digest("hex");
      });
    }

    function bind() {
      if (!args.bind) return;

      return output(args.bind).apply(async (component) => {
        const outputs = Object.entries(component).filter(
          ([key]) => !key.startsWith("__")
        );
        const keys = outputs.map(([key]) => key);
        const values = outputs.map(([_, value]) => value);

        return all(values).apply((values) => {
          const acc: Record<string, any> = {};
          keys.forEach((key, index) => {
            acc[key] = values[index];
          });
          // @ts-expect-error
          return `globalThis.${component.__name}=${JSON.stringify(acc)}`;
        });
      });
    }

    function wrapHandler() {
      return all([
        args.handler,
        args.bundle,
        streaming,
        injections,
        bindInjection,
      ]).apply(
        async ([handler, bundle, streaming, injections, bindInjection]) => {
          if (injections.length === 0 && !bindInjection) return handler;

          const {
            dir: handlerDir,
            name: oldHandlerName,
            ext: oldHandlerExt,
          } = path.posix.parse(handler);
          const oldHandlerFunction = oldHandlerExt.replace(/^\./, "");
          const newHandlerName = "server-index";
          const newHandlerFunction = "handler";
          await fs.promises.writeFile(
            path.join(bundle, handlerDir, `${newHandlerName}.mjs`),
            streaming
              ? [
                  `export const ${newHandlerFunction} = awslambda.streamifyResponse(async (event, context) => {`,
                  ...injections,
                  `  const { ${oldHandlerFunction}: rawHandler} = await import("./${oldHandlerName}.mjs");`,
                  `  return rawHandler(event, context);`,
                  `});`,
                ].join("\n")
              : [
                  `${bindInjection ?? ""};`,
                  `export const ${newHandlerFunction} = async (event, context) => {`,
                  ...injections,
                  `  const { ${oldHandlerFunction}: rawHandler} = await import("./${oldHandlerName}.mjs");`,
                  `  return rawHandler(event, context);`,
                  `};`,
                ].join("\n")
          );
          return path.posix.join(
            handlerDir,
            `${newHandlerName}.${newHandlerFunction}`
          );
        }
      );
    }

    function createRole() {
      return new aws.iam.Role(
        `${name}Role`,
        {
          assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
            Service: "lambda.amazonaws.com",
          }),
          inlinePolicies: args.policies,
          managedPolicyArns: [
            "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ],
        },
        { parent }
      );
    }

    function zipBundleFolder() {
      // Note: cannot point the bundle to the `.open-next/server-function`
      //       b/c the folder contains node_modules. And pnpm node_modules
      //       contains symlinks. Pulumi cannot zip symlinks correctly.
      //       We will zip the folder ourselves.
      return output(args.bundle).apply(async (bundle) => {
        const zipPath = path.resolve(
          $cli.paths.work,
          "artifacts",
          name,
          "code.zip"
        );
        await fs.promises.mkdir(path.dirname(zipPath), {
          recursive: true,
        });

        await new Promise(async (resolve, reject) => {
          const ws = fs.createWriteStream(zipPath);
          const archive = archiver("zip");
          archive.on("warning", reject);
          archive.on("error", reject);
          // archive has been finalized and the output file descriptor has closed, resolve promise
          // this has to be done before calling `finalize` since the events may fire immediately after.
          // see https://www.npmjs.com/package/archiver
          ws.once("close", () => {
            resolve(zipPath);
          });
          archive.pipe(ws);

          // set the date to 0 so that the zip file is deterministic
          archive.glob("**", { cwd: bundle, dot: true }, { date: new Date(0) });
          await archive.finalize();
        });

        return zipPath;
      });
    }

    function createBucketObject() {
      return new aws.s3.BucketObjectv2(
        `${name}Code`,
        {
          key: interpolate`assets/${name}-code-${bundleHash}.zip`,
          bucket: region.apply((region) => AWS.bootstrap.forRegion(region)),
          source: zipPath.apply((zipPath) => new asset.FileArchive(zipPath)),
        },
        { parent, retainOnDelete: true }
      );
    }

    function createFunction() {
      return new aws.lambda.Function(
        `${name}Function`,
        {
          description: args.description,
          code: new asset.AssetArchive({
            index: new asset.StringAsset("exports.handler = () => {}"),
          }),
          handler: newHandler,
          role: role.arn,
          runtime,
          timeout: timeout.apply((timeout) => toSeconds(timeout)),
          memorySize: memory.apply((memory) => toMBs(memory)),
          environment: {
            variables: environment,
          },
          architectures,
          ...args.nodes?.function,
        },
        { parent }
      );
    }

    function createLogGroup() {
      return new LogGroup(
        `${name}LogGroup`,
        {
          logGroupName: interpolate`/aws/lambda/${fn.name}`,
          retentionInDays: logging.apply(
            (logging) => RETENTION[logging.retention]
          ),
          region,
        },
        { parent }
      );
    }

    function createUrl() {
      return url.apply((url) => {
        if (url === undefined) return;

        return new aws.lambda.FunctionUrl(
          `${name}Url`,
          {
            functionName: fn.name,
            authorizationType: url.authorization.toUpperCase(),
            invokeMode: streaming.apply((streaming) =>
              streaming ? "RESPONSE_STREAM" : "BUFFERED"
            ),
            cors: url.cors,
          },
          { parent }
        );
      });
    }

    function updateFunctionCode() {
      return output([fnRaw]).apply(([fnRaw]) => {
        new FunctionCodeUpdater(
          `${name}CodeUpdater`,
          {
            functionName: fnRaw.name,
            s3Bucket: file.bucket,
            s3Key: file.key,
            functionLastModified: fnRaw.lastModified,
            region,
          },
          { parent }
        );
        return fnRaw;
      });
    }
  }

  public get nodes() {
    return {
      function: this.function,
      role: this.role,
      logGroup: this.logGroup,
    };
  }

  public get url() {
    return this.fnUrl.apply((url) => url?.functionUrl ?? output(undefined));
  }

  /** @internal */
  public getConstructMetadata() {
    return {
      type: "Function" as const,
      data: {
        arn: this.function.arn,
        runtime: this.function.runtime,
        handler: this.function.handler,
        missingSourcemap: this.missingSourcemap === true ? true : undefined,
        localId: this.urn,
        secrets: [] as string[],
      },
    };
  }
}
