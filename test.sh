npm run build --workspace @wundercorp/openmodel-aws-api

node --input-type=module <<'NODE'
import { handler } from "./apps/aws-api/dist/index.mjs";

const response = await handler({
  rawPath: "/health",
  headers: {},
  requestContext: {
    http: {
      method: "GET"
    }
  }
});

console.log(response);
NODE
