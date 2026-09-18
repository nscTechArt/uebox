# Writing graphs — wiring, layout, atomicity, repair

Details behind step 4 of the chain in `SKILL.md`. Read this when a write is more than a
single fresh graph: inserting into existing logic, or a call came back with warnings or
compile errors.

## Contents

- Wiring into an existing graph
- Picking up a graph that stopped half-written
- Removing nodes and wires
- Tidying up
- All or nothing
- Read the warnings
- Compiling and repairing

---

## Wiring into an existing graph

`connections` accepts two kinds of node id:

- an `id` from the `nodes` you are creating in this call, and
- **a `node_id` (GUID) of a node already in the graph**, exactly as
  `blueprint_get_graph` returns it.

So inserting a step into existing logic does not mean rewriting the whole graph:
read it, add the new nodes, and wire them to the existing GUIDs.

Each call only lays out the nodes *it* creates; they are placed below whatever is
already in the graph so nothing overlaps. After adding to a graph two or three
times the result is correct but stacked in blocks — run `blueprint_tidy_graph`
to re-flow the whole thing.

## Picking up a graph that stopped half-written

A write can stop partway — the call timed out, the editor went down, or you decided to
stop. **Resuming is still a batch job, not a repair-by-hand job.**

1. `blueprint_get_graph` — find out what is actually in there. Never resume from what
   you *meant* to write.
2. Send **all the remaining nodes in one call**, with `connections` that reach back to
   the existing ones by their `node_id`. Fifty of a hundred nodes landed? The next call
   carries the other fifty.

One call that builds fifty nodes costs about what one call that builds one node costs.
Fifty calls cost fifty times as much and drift further from the plan at every step.

`nodes: []` is legal and means "only add connections" — for a wire missing between two
nodes that both already exist. It is not a licence to grow a graph one node per call.
Sending it together with `clear_existing: true` is rejected, since that combination
empties the graph and builds nothing.

## Removing nodes and wires

These are for touch-ups after the batch, not for building.

- `blueprint_delete_node` — one node, by the `node_id` from `blueprint_get_graph`. Its
  wires go with it.
- `blueprint_disconnect_pins` — every wire on one pin. Pass `other_node_id` +
  `other_pin` (together) to break just one of them; that only matters on exec *inputs*,
  which several nodes can drive at once. Breaking a pin that has no wires is not a
  failure, so "make sure this is disconnected" is a single call.

Compile after either one: the node downstream may now be missing an input, and nothing
says so until you do.

Wholesale replacement is still `blueprint_apply_graph` with `clear_existing: true` —
send the nodes you want to keep, everything else in the graph goes.

Do not reach for `ue_undo` to take one node back out. Undo replays a whole transaction,
so it takes the rest of that call with it.

## Tidying up

`blueprint_tidy_graph` re-lays-out an entire existing graph — including nodes you
did not create — so it reads left-to-right along the execution flow. It moves nodes
only; no node, wire or value is touched, and the change is undoable.

Worth doing when you have built a graph across several calls, or when the user says
the graph is hard to read. Take a `ue_screenshot` afterwards if you want to confirm.

## All or nothing

If any node or connection fails, the whole call is rolled back: the Blueprint is
left exactly as it was, nothing is compiled, nothing is saved.

So when a call fails, **fix the errors and re-send the complete node and connection
set**. Do not send only the parts that failed — the earlier parts were never applied,
and re-sending only the remainder will produce a graph missing its first half.

The errors name the offending entry and, where it helps, list what was available:

```
nodes[1] 'say': Function not found: PrintStrng (did you mean: PrintString?)
connections[0]: pin 'exec' not found on 'say' (available: execute(Input), then(Output), ...)
```

## Read the warnings

The engine sometimes does things you did not ask for, and they come back in
`warnings`:

- **it replaced an existing connection** — an input pin takes only one link, so
  wiring to a pin that was already connected silently drops the old link
- **it inserted a conversion node** — the graph then has one more node than you
  specified, and your ids do not cover it
- **it promoted a pin type** to make the connection fit

If you ignore these, your next `blueprint_get_graph` will not match what you
thought you wrote.

`undoable: false` in the response means this change cannot be undone with Ctrl+Z
(the editor's transaction system was unavailable). Worth telling the user before
you make further changes.

## Compiling and repairing

`blueprint_apply_graph` compiles by default. Compile errors do **not** mean the write
failed — the graph is in place. Diagnostics come back keyed to *your* node ids:

```
diagnostics: [ { severity: "error", node: "check",
                 message: "Condition pin is not connected" } ]
```

Fix the named node and re-send the complete graph. Do not re-send unchanged input.

Warnings alone are fine — the Blueprint compiles and saves. Relay the warning to the
user rather than trying to "fix" something that is not an error. `InputAction` nodes
warn when the action is not in the project's input settings; either ask the user to add
the mapping, or drive the logic from an event that needs no configuration
(`ReceiveBeginPlay`, an overlap event) and say why you switched.
