---
name: ue-widget-umg-layout
description: Build or edit a UMG Widget Blueprint — create it, place controls with anchors and sizes, swap or delete controls in an existing UI, set text/colour/any editable property, bind button clicks, expose controls as variables, and render a preview to check the result. Use when the user wants a HUD, menu or any in-game UI, or wants to change one they already have. Do not use for editing Blueprint node graphs, or for placing actors in the level.
---

# UMG widget layout

Verified against UE 5.5.4 with UnrealAgentLink by building a health-bar HUD end to end and
looking at the rendered result.

## The chain

```
widget_create          root container: CanvasPanel / VerticalBox / ScrollBox / GridPanel / …
widget_add_child       one call per control, carries its own initial layout
widget_set_slot        move/resize/align a control that is already there
widget_set_property    text, percent, colour, visibility — or any editable property by name
widget_replace         swap a control for another type in place (keeps slot, name, events)
widget_remove          delete a control and its children
widget_make_variable   expose a control so Blueprint can drive it
blueprint_component_event   bind a button's OnClicked (component_name = the control's name)
widget_get_hierarchy   read back the real structure and slot data
widget_preview         render it and LOOK at it
```

## Control types are not a short list

`control_type` and `root_type` take any widget class the engine knows. The named ones are
`Button`, `TextBlock`, `RichTextBlock`, `Image`, `CanvasPanel`, `VerticalBox`, `HorizontalBox`,
`Overlay`, `Border`, `ScrollBox`, `SizeBox`, `Spacer`, `ProgressBar`, `Slider`, `CheckBox`,
`ComboBoxString`, `EditableText`, `EditableTextBox`, `SpinBox`, `GridPanel`, `WrapBox`,
`UniformGridPanel`. Anything else works too: a native class by name without the `U`
(`CommonButtonBase`), and a project's own Widget Blueprint by asset name (`WB_Text_Button`) or path
(`/Game/UI/WB_Text_Button`). If a name matches two Widget Blueprints the error lists both paths.

A scrolling list is a `ScrollBox`, a text field is an `EditableTextBox`, an inventory grid is a
`UniformGridPanel`. Do not fake them out of the four containers you happen to remember.

Slot arguments on `widget_add_child` only apply to CanvasPanel / VerticalBox / HorizontalBox /
Overlay parents. Adding into a ScrollBox or a grid works, but the child lands with default slot
settings.

## Preview returns the actual image — use it

`widget_preview` renders the widget and hands the image back to you directly. This is the only
tool in the UI set that tells you whether the thing you built looks right.

Call it after any layout change and actually read the picture: overlapping controls, text
running off the edge, a bar that is the wrong colour — none of that shows up in
`widget_get_hierarchy`, which will happily report a perfectly sensible tree for a broken layout.

Then tell the user what you saw, not just that the call succeeded. Whether it *looks good* is
the user's call; overlap, clipping and overflow are yours to catch.

It renders in designer mode: PreConstruct runs, Construct and the event graph do not. Anything
the game fills in at runtime shows as its design-time default.

Preview with the longest content the game will really put there, not the placeholder: set the
longest text (`"Score: 1,250,000"`, the longest translation, a 16-character player name) with
`widget_set_property`, preview, then set the default back. `"Score: 0"` fits anything.

### Other screen sizes: vary the aspect ratio, not just the resolution

`widget_preview` applies the project's DPI curve for the size you ask for, the same as the game,
and reports the `dpi_scale` it used. By default UMG scales by the screen's short side, so 720p,
1080p and 4K at 16:9 lay out almost identically — previewing all three proves little. What
really changes the layout is the aspect ratio, so hold the height and vary the width:

| aspect | `width` × `height` |
|---|---|
| 16:9 | 1920 × 1080 |
| 21:9 | 2520 × 1080 |
| 16:10 | 1728 × 1080 |
| 4:3 | 1440 × 1080 |

If the result has no `dpi_scale`, the plugin is older and drew at scale 1: then only the
1080-high rows above match the game.

## Layout: set it on add, fix it with `widget_set_slot`

Position, size, anchors and alignment are arguments to `widget_add_child`, so decide them when
you add the control. When the preview shows it sitting wrong, `widget_set_slot` changes them on
a control that already exists — **never delete and re-add to nudge a position**, that throws away
the control's properties, event bindings and variable flag.

`widget_set_slot` takes one group of arguments, chosen by the parent:

- in a CanvasPanel: `anchors`, `position`, `size`, `alignment`, `z_order`
- in a VerticalBox: `size_rule`, `padding`, `h_align`, `v_align`

Passing both groups is an error, not a guess. `anchors: "Center"` alone puts the control's
*top-left* at the centre; real centring also needs `alignment: { x: 0.5, y: 0.5 }`.

```
anchors:  "TopLeft" | "Center" | "BottomRight" | "Stretch" | …
position: { x: 40, y: 40 }        ← x / y
size:     { width: 300, height: 24 }   ← width / height, NOT x / y
padding:  { left, top, right, bottom }
h_align / v_align: Fill | Left/Top | Center | Right/Bottom
```

`position` and `size` use different key names. Getting it wrong is a clear validation error, not
a silent failure, so fix and retry — but write it correctly the first time.

Anchors decide what the control does when the screen changes shape. A HUD element pinned to a
corner wants that corner's anchor (`TopLeft` for a health bar, `BottomCenter` for a hotbar); a
background wants `Stretch`. Choosing `TopLeft` for everything gives a layout that breaks on any
other aspect ratio — check it with the width table under "Preview returns the actual image".

## Properties you can set

`Text`, `Visibility`, `IsEnabled`, `ToolTipText`, `Percent`, `FontSize`, `Justification`, and
the colour trio: `FillColorAndOpacity` (ProgressBar), `ColorAndOpacity` (TextBlock / Image),
`BrushColor` (Border).

Colour values are **0..1 floats**, not 0..255:

```
{ "r": 0.85, "g": 0.12, "b": 0.12, "a": 1 }
```

`FontSize` is a number and works on `TextBlock` / `RichTextBlock`; it changes the size only and
leaves the typeface alone. `Justification` takes `Left` / `Center` / `Right` on any text control.

Anything else in the control's Details panel can be set by its property name; the plugin finds it
by reflection. Struct values take an object with only the fields you change, asset references take
an object path:

```
property_name: "Background"     (a Border)
value: { "DrawAs": "RoundedBox",
         "OutlineSettings": { "RoundingType": "FixedRadius", "CornerRadii": { "X": 8, "Y": 8, "Z": 8, "W": 8 } } }
```

A project widget placed inside this one (a `WB_Text_Button`) exposes the variables its author
ticked **Instance Editable** — that is how its label is set (`InText` or similar). If the name is
wrong, the error lists what that control can take; pick from that list. A variable that exists but
is not Instance Editable is refused with that reason: tell the user to tick it, do not work around it.

When a call fails, read the `error` and the `hint` in the return: they say whether the control was
not found, the value type was wrong, or that control type simply has no such property. Retrying
with a different property name is not a fix.

## Updating text at runtime: `TextBlock.SetText`, never `SetTextPropertyByName`

A score that has to change while the game runs is set in the Blueprint graph, not here. Use the
control's own member function — `TextBlock.SetText`, `ProgressBar.SetPercent`,
`Border.SetBrushColor` — written straight into `blueprint_apply_graph` as
`member_name: "TextBlock.SetText"`.

`blueprint_search_nodes` **will not find these**. Its range is function libraries plus the
Blueprint's own parent chain, and a control class is neither. Searching for `SetText` returns
`KismetSystemLibrary.SetTextPropertyByName` instead — and that node is a trap: it writes the
field by reflection without telling Slate, so the value changes and **the screen never repaints**.
The variable reads back correctly while the user stares at the old number.

Not finding a function in the search does not mean it does not exist. Write the class name
yourself.

## Getting it on screen in the game

A Widget Blueprint shows nothing until something creates it and adds it to the viewport. Write
that into the player's Blueprint (the player Character or PlayerController), on BeginPlay:

```json
{
  "blueprint_path": "/Game/Blueprints/BP_PlayerCharacter",
  "nodes": [
    { "id": "begin", "class": "Event", "member_name": "ReceiveBeginPlay" },
    { "id": "pc", "class": "Function", "member_name": "GameplayStatics.GetPlayerController",
      "pin_defaults": { "PlayerIndex": "0" } },
    { "id": "make", "class": "CreateWidget", "target_class": "WBP_HUD" },
    { "id": "show", "class": "Function", "member_name": "UserWidget.AddToViewport" }
  ],
  "connections": [
    { "from": "begin.then", "to": "make.execute" },
    { "from": "pc.ReturnValue", "to": "make.OwningPlayer" },
    { "from": "make.then", "to": "show.execute" },
    { "from": "make.ReturnValue", "to": "show.self" }
  ]
}
```

- `target_class` sets the widget class and gives the return pin that exact type, so later nodes
  can call the widget's own functions. It must be a Widget Blueprint; actors use `SpawnActor`.
- `AddToViewport` needs the `UserWidget.` prefix; without it the lookup only searches the
  Blueprint's own class.
- After `blueprint_compile`, run `ue_playtest` and look at the screenshot: the widget should be
  on screen. Compiling only proves the graph is valid.
- Keep the return value in a variable if anything later updates or closes it
  (`Widget.RemoveFromParent`).
- A menu also needs input routed to it: `WidgetBlueprintLibrary.SetInputMode_UIOnlyEx` (or
  `SetInputMode_GameAndUIEx`) with the player controller, plus `VariableSet`
  `PlayerController.bShowMouseCursor` = true. Closing it reverses both
  (`SetInputMode_GameOnly`). Without this the menu draws but the game keeps the mouse.

## Checking it actually shows on screen

`widget_preview` renders the widget asset and is the right check for layout, colour and sizing.

For "is my HUD really up during play", the **default** paths of `ue_screenshot` and `ue_playtest`
are useless: those render the scene, and UMG is a layer drawn on top of it. A clean-looking
screenshot with no HUD in it proves nothing. Three things that do work:

- `ue_screenshot` with `show_ui: true` — grabs the editor window as the user sees it, PIE
  viewport and HUD included.
- `ue_playtest` with `frame_mode: "window"` and `frames: 6` — same pixels, but sampled over the
  whole run and stitched into one timeline image. This is the only way to see a HUD that appears,
  changes or disappears *while the game runs* — a single frame cannot tell "never showed up"
  from "showed up and went away". The editor's panels are in those frames too, so the game area
  is only part of each cell; read numbers off it only if they are large.
- Ask the user to press Play and tell you what the screen says.

Reading the TextBlock's `Text` property back is **not** evidence that the text is on screen —
that is exactly the false positive `SetTextPropertyByName` produces. Say what you verified and
how; do not report a runtime UI as confirmed on the strength of a property read.

## Changing a UI the user already has

Most requests are about an existing screen, not a new one: "make the login button look like the
nav buttons", "remove that panel". Read it first with `widget_get_hierarchy`, then change it in
place. Do not add a second control next to the old one and leave the old one for the user.

**Swap a control for another type** with `widget_replace`. Name, slot (position, anchors, size,
alignment, padding), visibility and enabled state stay; children move over if the new type can
hold them. Events bound to the old control are moved to the new class's event and the logic wired
after them stays connected. When the new class has no event of the same name the plugin refuses
and lists what it can bind — pass `event_map`:

```
widget_replace  path: "/Game/UI/WB_StartScreen", widget_name: "Btn_Login",
                new_type: "WB_Text_Button",
                event_map: { "OnClicked": "OnButtonBaseClicked" },
                drop_children: true
```

A plain `Button` holds its label as a child `TextBlock`; a CommonUI button usually has no slot for
it, so the replace is refused until you pass `drop_children: true`. The receipt gives the label
text it dropped and the new control's `editable_properties`: set the label there with
`widget_set_property` (`InText` or whatever the list says). Then `blueprint_compile` — nodes that
called functions only the old class had show up as compile errors — and `widget_preview`.

A refused call changed nothing; add what it asks for and call again.

**Delete a control** with `widget_remove`. Its children go with it. If the graph still uses any of
them it refuses and lists the nodes; `force: true` removes those nodes too (logic wired after a
removed event stays in the graph, disconnected).

## Button clicks

`blueprint_component_event` binds them: `blueprint_path` is the Widget Blueprint, `component_name`
is the control's name. `action: "list"` shows what the control can bind; a plain `Button` has
`OnClicked`, a CommonUI button `OnButtonBaseClicked`. `action: "add"` returns the event node and
its pins — wire `then` to the logic with `blueprint_apply_graph`. The control becomes a variable
automatically.

## Exposing controls to Blueprint

A control is only reachable from the Widget Blueprint's graph if it is a variable.
`widget_make_variable` does that; `widget_get_hierarchy` reports `is_variable` so you can check.

Any control the game needs to update at runtime — a health bar's `Percent`, a score `TextBlock` —
must be exposed. `variable_name` renames the control the way the editor does: nodes that get/set it
and events bound to it follow the new name. A name already taken is refused — pick another. If the
receipt says `graph_references_updated: false`, the nodes it lists still use the old name; fix those.
Values set with `widget_set_property` are just the design-time defaults;
they are what the user sees in the editor, not what the game will show.

## Reading the structure back

`widget_get_hierarchy` returns each control's `slot_data` with the resolved `position`, `size`
and `anchors` — use it to confirm layout actually applied.

`visibility` is the design-time `ESlateVisibility` value (`Visible`,
`SelfHitTestInvisible`, `Hidden`, `Collapsed`). A CanvasPanel root normally reports
`SelfHitTestInvisible` — that is correct and not something to fix.
