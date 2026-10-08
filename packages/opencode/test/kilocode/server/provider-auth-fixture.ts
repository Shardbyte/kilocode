import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Layer } from "effect"
import { ModelCache } from "@/provider/model-cache"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testInstanceStoreLayer } from "../../fixture/fixture"

// Route fixtures use the real invalidation services without bootstrapping sessions.
export const lifecycle = Layer.merge(AppNodeBuilder.build(ModelCache.node), testInstanceStoreLayer).pipe(
  Layer.provide(AppNodeBuilder.build(CrossSpawnSpawner.node)),
)
