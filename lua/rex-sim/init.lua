-- rex-sim for Rex: an iOS simulator or Android emulator, live in a pane.
--
-- The rex-sim program draws the device with Kitty graphics and sends it your
-- clicks and keys. This module adds the actions that open its pane and press
-- its buttons from anywhere.
--
-- In ~/.config/rex/init.lua, with Amber:
--
--   { "wobsoriano/rex-sim", opts = { keys = { toggle = "cmd+shift+s" } } }
--
-- or directly:
--
--   dofile("/path/to/rex-sim/lua/rex-sim/init.lua").setup{}
--
-- setup options:
--   node       the node to run rex-sim with (default "node", found on your
--              login shell's PATH)
--   placement  "split" (beside the focused pane, default), "float", or "tab"
--   width      the pane's share of the width, for "split" (default 0.4)
--   bounds     { x, y, w, h } as fractions of the window, for "float"
--   device     the device a new pane starts on: a simulator's UDID or
--              avd:<name>. Default: the one picked last, else the first running.
--   keys       keys for actions by short name, such as { toggle = "cmd+shift+s" }

local M = {}

local DEFAULTS = {
  node = "node",
  placement = "split",
  width = 0.4,
  bounds = { 0.62, 0.03, 0.36, 0.94 },
  device = false,
  keys = {},
}
M.options = {}
for k, v in pairs(DEFAULTS) do M.options[k] = v end

local SHELL = "com.superlogical.terminal.shell"
local TERMINAL = "com.superlogical.terminal"
local LABEL = "rex-sim"

-- This file is <repo>/lua/rex-sim/init.lua; the program is <repo>/bin/rex-sim.mjs.
local ROOT = debug.getinfo(1, "S").source:gsub("^@", ""):match("^(.*)/lua/[^/]+/[^/]+$") or "."

local function fail(message)
  error("rex-sim: " .. message, 0)
end

local function check(result, err)
  if result == nil then fail(tostring(err)) end
  return result
end

-- The pane in the focused one's window, else any.
local function locate(ctx)
  local list = check(rex.session.list_blocks{})
  local focused
  for _, b in ipairs(list.blocks or {}) do
    if b.block_id == ctx.block_id then focused = b end
  end
  if focused and focused.label == LABEL then return focused end
  local any
  for _, b in ipairs(list.blocks or {}) do
    if b.label == LABEL then
      if focused and b.window_id == focused.window_id then return b end
      any = any or b
    end
  end
  return any
end

-- The floating layer a block is in, or nil.
local function layer_of(block_id)
  local view = check(rex.session.view{})
  for _, w in ipairs(view.windows or {}) do
    for _, layer in ipairs(w.layers or {}) do
      if layer.kind == "floating" then
        for _, b in ipairs(layer.blocks or {}) do
          if b.block_id == block_id then return layer end
        end
      end
    end
  end
end

-- rex-sim reads a command typed into its pane as ESC _ rex-sim;<command> ESC \,
-- which no key types.
local function send(block_id, command)
  check(rex.block.call(TERMINAL, "write", { block_id = block_id, data = "\27_rex-sim;" .. command .. "\27\\" }))
end

function M.open(ctx, args)
  args = args or {}
  local o = M.options
  local command = { o.node, ROOT .. "/bin/rex-sim.mjs" }
  local device = args.device or o.device
  if device then
    command[#command + 1] = "--device"
    command[#command + 1] = device
  end
  local block = { flavor = SHELL, label = LABEL, options = { command = command, cwd = ROOT } }
  local placement = args.placement or o.placement
  local result, err
  if placement == "split" and ctx.block_id then
    result, err = rex.session.new_split{
      anchor_id = ctx.block_id,
      direction = "horizontal",
      side = "after",
      ratio = 1 - o.width,
      focus = false,
      layout = { block = block },
    }
  elseif placement == "float" or placement == "split" then
    result, err = rex.session.new_layer{ bounds = o.bounds, focus = false, layout = { block = block } }
  elseif placement == "tab" then
    result, err = rex.session.new_window{ layout = { block = block }, focus = false, window_label = "Simulator" }
  else
    fail('placement must be "split", "float" or "tab"')
  end
  check(result, err)
  return { block_id = result.block_ids and result.block_ids[1] }
end

function M.close(ctx)
  local pane = locate(ctx)
  if not pane then return { closed = false } end
  check(rex.block.call(TERMINAL, "write", { block_id = pane.block_id, data = "\3" }))
  return { closed = true, block_id = pane.block_id }
end

-- Open the pane, or close it. A floating pane is hidden and shown instead,
-- and stops streaming while hidden.
function M.toggle(ctx, args)
  local pane = locate(ctx)
  if not pane then return M.open(ctx, args) end
  local layer = layer_of(pane.block_id)
  if not layer then return M.close(ctx) end
  local state = layer.state == "minimized" and "normal" or "minimized"
  if state == "minimized" then send(pane.block_id, "pause") end
  local result, err = rex.call("session.set_layer_state", {
    session_id = ctx.session_id, layer_id = layer.layer_id, state = state, focus = false,
  })
  -- A Rex without minimized layers closes the pane instead.
  if result == nil and state == "minimized" then return M.close(ctx) end
  check(result, err)
  if state == "normal" then send(pane.block_id, "resume") end
  return { block_id = pane.block_id, state = state }
end

-- Sends a command to the pane from wherever you are.
local function command_action(command)
  return function(ctx)
    local pane = locate(ctx)
    if not pane then fail("no simulator pane is open; run Simulator: Toggle first") end
    send(pane.block_id, command)
    return { block_id = pane.block_id }
  end
end

function M.setup(opts)
  for k, v in pairs(opts or {}) do
    if DEFAULTS[k] == nil then
      rex.log("warn", "rex-sim: ignoring unknown option " .. tostring(k))
    else
      M.options[k] = v
    end
  end

  local function action(name, title, description, run, args)
    rex.action{
      name = name, title = title, description = description, category = "Simulator",
      keywords = "simulator emulator ios android iphone device", args = args, run = run,
    }
  end

  action("sim_toggle", "Simulator: Toggle",
    "Open a live iOS simulator or Android emulator beside the focused pane, or close it.",
    function(ctx, args) return M.toggle(ctx, args) end, { device = "string?", placement = "string?" })
  action("sim_open", "Simulator: Open",
    "Open a live iOS simulator or Android emulator in a new pane.",
    function(ctx, args) return M.open(ctx, args) end, { device = "string?", placement = "string?" })
  action("sim_close", "Simulator: Close", "Close the simulator pane.",
    function(ctx) return M.close(ctx) end)
  action("sim_devices", "Simulator: Pick Device", "Open the device picker in the simulator pane.", command_action("devices"))
  action("sim_device", "Simulator: Show Device",
    "Show a device in the simulator pane, booting it if it is off. Takes a simulator's UDID or avd:<name>.",
    function(ctx, args) return command_action("device;" .. args.device)(ctx) end, { device = "string" })
  action("sim_home", "Simulator: Home", "Press the device's Home button.", command_action("home"))
  action("sim_lock", "Simulator: Lock", "Press the device's Lock button.", command_action("lock"))
  action("sim_volume_up", "Simulator: Volume Up", "Press the device's volume up button.", command_action("volume-up"))
  action("sim_volume_down", "Simulator: Volume Down", "Press the device's volume down button.", command_action("volume-down"))
  action("sim_rotate", "Simulator: Rotate", "Rotate the device a quarter turn.", command_action("rotate"))
  action("sim_keyboard", "Simulator: Toggle Software Keyboard", "Show or hide the iOS on-screen keyboard.", command_action("keyboard"))
  action("sim_repair", "Simulator: Repair Input",
    "For when taps on an iOS simulator do nothing. Restarts SpringBoard, so open apps close.", command_action("repair"))

  for short, key in pairs(M.options.keys or {}) do
    rex.bind(key, "sim_" .. short)
  end
  return M
end

return M
