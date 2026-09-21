--[[
CPlus Talents - import builds from the talent calculator and apply them in game.

    /cplus                 open the window
    /cplus import          paste a build string
    /cplus list            print saved loadouts to chat

A build arrives as a string the site produces:

    cpt1|forever|WARRIOR|Fury 31/20|Booming Voice=5,Cruelty=5,...

Talents are named, not numbered. Every name is resolved with GetTalentInfo at
apply time, so a build can never land points on the wrong talent because the
site's tree order differs from this client's - which would cost real gold to
undo. A name this client does not have stops the whole apply before a single
point is spent.

Nothing is spent without you pressing Apply, and then one point at a time,
stopping the moment anything looks wrong.
]]--

local ADDON = ...
local PREFIX = "cpt1"

CPlusTalentsDB = CPlusTalentsDB or { loadouts = {} }

-- The working parts hang off one table rather than staying local, so they can be
-- tested outside the game, where there is no client to ask.
CPlusTalents = CPlusTalents or {}

-- one point per level from 10, which is what the calculator assumes too
local function pointsAvailable()
  return UnitCharacterPoints and UnitCharacterPoints("player") or GetUnspentTalentPoints()
end

local function printf(...)
  DEFAULT_CHAT_FRAME:AddMessage("|cffffd100CPlus|r " .. string.format(...))
end

--------------------------------------------------------------------- parsing

--- Splits "a,b,c" on sep. Lua has no split, and gmatch on a class is simplest.
local function split(text, sep)
  local out = {}
  for piece in string.gmatch(text, "([^" .. sep .. "]+)") do
    out[#out + 1] = piece
  end
  return out
end

local function trim(s)
  return (string.gsub(s, "^%s*(.-)%s*$", "%1"))
end

--- Turns an export string into { name, class, edition, talents = {[name]=rank} }.
-- Returns nil plus a reason when it cannot.
function CPlusTalents.parseBuild(text)
  if type(text) ~= "string" then return nil, "nothing to read" end
  text = trim(text)

  local fields = split(text, "|")
  if #fields < 5 then return nil, "that is not a build string" end
  if fields[1] ~= PREFIX then
    return nil, "unknown format '" .. tostring(fields[1]) .. "'"
  end

  local build = {
    edition = fields[2],
    class   = string.upper(fields[3]),
    name    = trim(fields[4]),
    talents = {},
    order   = {},
  }

  for _, pair in ipairs(split(fields[5], ",")) do
    local name, rank = string.match(pair, "^(.-)=(%d+)$")
    if not name then return nil, "could not read '" .. pair .. "'" end
    name = trim(name)
    build.talents[name] = tonumber(rank)
    build.order[#build.order + 1] = name
  end

  if #build.order == 0 then return nil, "that build has no talents in it" end
  return build
end

------------------------------------------------------------------- the trees

--- Every talent this character has, by name -> {tab, index, rank, maxRank, tier}.
function CPlusTalents.readTalents()
  local byName = {}
  for tab = 1, GetNumTalentTabs() do
    for index = 1, GetNumTalents(tab) do
      local name, _, tier, _, rank, maxRank = GetTalentInfo(tab, index)
      if name then
        byName[name] = { tab = tab, index = index, rank = rank, maxRank = maxRank, tier = tier }
      end
    end
  end
  return byName
end

--- What applying this build would do, without doing any of it.
-- Returns steps (tab/index/name/from/to) and a list of problems.
function CPlusTalents.plan(build)
  local problems = {}

  local _, class = UnitClass("player")
  if build.class ~= string.upper(class) then
    problems[#problems + 1] = "this build is for a " .. build.class .. ", you are a " .. class
  end

  local have = CPlusTalents.readTalents()
  local steps, needed, spent = {}, 0, 0

  for _, name in ipairs(build.order) do
    local want = build.talents[name]
    local here = have[name]
    if not here then
      problems[#problems + 1] = "no talent called '" .. name .. "' on this character"
    else
      if want > here.maxRank then
        problems[#problems + 1] = name .. " only goes to " .. here.maxRank
        want = here.maxRank
      end
      if here.rank > want then
        problems[#problems + 1] = name .. " is already at " .. here.rank .. ", more than the build's " .. want
      elseif here.rank < want then
        steps[#steps + 1] = {
          tab = here.tab, index = here.index, name = name,
          from = here.rank, to = want, tier = here.tier,
        }
        needed = needed + (want - here.rank)
      end
      spent = spent + here.rank
    end
  end

  -- lowest tier first, so every tier gate is paid for before it is needed
  table.sort(steps, function(a, b)
    if a.tier ~= b.tier then return a.tier < b.tier end
    return a.name < b.name
  end)

  local free = pointsAvailable()
  if needed > free then
    problems[#problems + 1] = "needs " .. needed .. " points, you have " .. free
  end

  return steps, problems, needed, free
end

--- Spends the points, one at a time, stopping the moment anything is refused.
function CPlusTalents.apply(build)
  if InCombatLockdown and InCombatLockdown() then
    printf("|cffff6a6aNot in combat.|r")
    return
  end

  local steps, problems, needed = CPlusTalents.plan(build)
  if #problems > 0 then
    printf("|cffff6a6aStopped, nothing spent:|r")
    for _, p in ipairs(problems) do printf("  %s", p) end
    return
  end
  if needed == 0 then
    printf("Already matches '%s'.", build.name)
    return
  end

  local put = 0
  for _, step in ipairs(steps) do
    for _ = step.from + 1, step.to do
      LearnTalent(step.tab, step.index)
      -- trust the client, not our own count: re-read what actually happened
      local _, _, _, _, rank = GetTalentInfo(step.tab, step.index)
      if not rank or rank <= step.from then
        printf("|cffff6a6a%s would not go past %d - stopped after %d point(s).|r",
          step.name, rank or 0, put)
        return
      end
      step.from = rank
      put = put + 1
    end
  end
  printf("Applied '%s' - %d point(s) spent.", build.name, put)
end

--------------------------------------------------------------------- the window

local ui

local function refresh()
  if not ui or not ui:IsShown() then return end

  local names = {}
  for name in pairs(CPlusTalentsDB.loadouts) do names[#names + 1] = name end
  table.sort(names)
  ui.names = names

  if not ui.selected or not CPlusTalentsDB.loadouts[ui.selected] then
    ui.selected = names[1]
  end

  if not ui.selected then
    ui.title:SetText("No loadouts yet")
    ui.body:SetText("Copy a build from the calculator, then\n|cffffd100/cplus import|r and paste it here.")
    ui.apply:Disable()
    return
  end

  local build, why = CPlusTalents.parseBuild(CPlusTalentsDB.loadouts[ui.selected])
  if not build then
    ui.title:SetText(ui.selected)
    ui.body:SetText("|cffff6a6a" .. (why or "unreadable") .. "|r")
    ui.apply:Disable()
    return
  end

  local steps, problems, needed, free = CPlusTalents.plan(build)
  ui.title:SetText(string.format("%s  |cff9d9d9d(%s, %s)|r", build.name, build.class, build.edition))

  local lines = {}
  if #problems > 0 then
    for _, p in ipairs(problems) do lines[#lines + 1] = "|cffff6a6a" .. p .. "|r" end
    lines[#lines + 1] = " "
  end
  lines[#lines + 1] = string.format("Would spend |cffffd100%d|r of your |cffffd100%d|r points:", needed, free)
  for i, step in ipairs(steps) do
    if i > 14 then
      lines[#lines + 1] = string.format("  |cff9d9d9d...and %d more|r", #steps - 14)
      break
    end
    lines[#lines + 1] = string.format("  %s  |cff9d9d9d%d -> %d|r", step.name, step.from, step.to)
  end

  ui.body:SetText(table.concat(lines, "\n"))
  if #problems > 0 or needed == 0 then ui.apply:Disable() else ui.apply:Enable() end
end

local function pickNext(delta)
  if not ui.names or #ui.names == 0 then return end
  local at = 1
  for i, n in ipairs(ui.names) do if n == ui.selected then at = i end end
  at = at + delta
  if at < 1 then at = #ui.names elseif at > #ui.names then at = 1 end
  ui.selected = ui.names[at]
  refresh()
end

local function buildUI()
  if ui then return ui end

  ui = CreateFrame("Frame", "CPlusTalentsFrame", UIParent, "BasicFrameTemplateWithInset")
  ui:SetSize(430, 380)
  ui:SetPoint("CENTER")
  ui:SetMovable(true)
  ui:EnableMouse(true)
  ui:RegisterForDrag("LeftButton")
  ui:SetScript("OnDragStart", ui.StartMoving)
  ui:SetScript("OnDragStop", ui.StopMovingOrSizing)
  ui:SetFrameStrata("DIALOG")
  if ui.TitleText then ui.TitleText:SetText("CPlus Talents") end
  table.insert(UISpecialFrames, "CPlusTalentsFrame")   -- Escape closes it

  local prev = CreateFrame("Button", nil, ui, "UIPanelButtonTemplate")
  prev:SetSize(24, 22)
  prev:SetPoint("TOPLEFT", 14, -32)
  prev:SetText("<")
  prev:SetScript("OnClick", function() pickNext(-1) end)

  local nextb = CreateFrame("Button", nil, ui, "UIPanelButtonTemplate")
  nextb:SetSize(24, 22)
  nextb:SetPoint("TOPRIGHT", -14, -32)
  nextb:SetText(">")
  nextb:SetScript("OnClick", function() pickNext(1) end)

  ui.title = ui:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  ui.title:SetPoint("TOP", 0, -37)
  ui.title:SetWidth(330)

  ui.body = ui:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  ui.body:SetPoint("TOPLEFT", 20, -62)
  ui.body:SetWidth(390)
  ui.body:SetJustifyH("LEFT")
  ui.body:SetJustifyV("TOP")

  ui.apply = CreateFrame("Button", nil, ui, "UIPanelButtonTemplate")
  ui.apply:SetSize(120, 24)
  ui.apply:SetPoint("BOTTOMRIGHT", -16, 16)
  ui.apply:SetText("Apply")
  ui.apply:SetScript("OnClick", function()
    local build = CPlusTalents.parseBuild(CPlusTalentsDB.loadouts[ui.selected or ""] or "")
    if build then CPlusTalents.apply(build) end
    refresh()
  end)

  local del = CreateFrame("Button", nil, ui, "UIPanelButtonTemplate")
  del:SetSize(90, 24)
  del:SetPoint("BOTTOMLEFT", 16, 16)
  del:SetText("Delete")
  del:SetScript("OnClick", function()
    if ui.selected then
      CPlusTalentsDB.loadouts[ui.selected] = nil
      ui.selected = nil
      refresh()
    end
  end)

  local imp = CreateFrame("Button", nil, ui, "UIPanelButtonTemplate")
  imp:SetSize(90, 24)
  imp:SetPoint("BOTTOM", 0, 16)
  imp:SetText("Import")
  imp:SetScript("OnClick", function() CPlusTalents_OpenImport() end)

  ui:SetScript("OnShow", refresh)
  return ui
end

--------------------------------------------------------------------- importing

local importBox

function CPlusTalents_OpenImport()
  if not importBox then
    importBox = CreateFrame("Frame", "CPlusTalentsImport", UIParent, "BasicFrameTemplateWithInset")
    importBox:SetSize(430, 190)
    importBox:SetPoint("CENTER", 0, 120)
    importBox:SetFrameStrata("FULLSCREEN_DIALOG")
    importBox:EnableMouse(true)
    if importBox.TitleText then importBox.TitleText:SetText("Paste a build") end
    table.insert(UISpecialFrames, "CPlusTalentsImport")

    local hint = importBox:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    hint:SetPoint("TOPLEFT", 18, -34)
    hint:SetWidth(390)
    hint:SetJustifyH("LEFT")
    hint:SetText("Paste the string from the calculator's |cffffd100For game|r button.")

    local edit = CreateFrame("EditBox", nil, importBox, "InputBoxTemplate")
    edit:SetSize(370, 28)
    edit:SetPoint("TOPLEFT", 22, -62)
    edit:SetAutoFocus(true)
    edit:SetMaxLetters(2000)
    importBox.edit = edit

    local msg = importBox:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    msg:SetPoint("TOPLEFT", 18, -98)
    msg:SetWidth(390)
    msg:SetJustifyH("LEFT")
    importBox.msg = msg

    local save = CreateFrame("Button", nil, importBox, "UIPanelButtonTemplate")
    save:SetSize(110, 24)
    save:SetPoint("BOTTOMRIGHT", -16, 16)
    save:SetText("Save loadout")
    save:SetScript("OnClick", function()
      local text = edit:GetText()
      local build, why = CPlusTalents.parseBuild(text)
      if not build then
        msg:SetText("|cffff6a6a" .. (why or "could not read that") .. "|r")
        return
      end
      CPlusTalentsDB.loadouts[build.name] = trim(text)
      msg:SetText("|cff3ddc00Saved '" .. build.name .. "'.|r")
      edit:SetText("")
      if ui then ui.selected = build.name end
      refresh()
    end)

    edit:SetScript("OnEnterPressed", function() save:Click() end)
    edit:SetScript("OnEscapePressed", function() importBox:Hide() end)
  end
  importBox.msg:SetText("")
  importBox:Show()
  importBox.edit:SetFocus()
end

--------------------------------------------------------------------- commands

SLASH_CPLUS1 = "/cplus"
SlashCmdList["CPLUS"] = function(arg)
  arg = string.lower(trim(arg or ""))

  if arg == "import" then
    buildUI()
    CPlusTalents_OpenImport()
    return
  end

  if arg == "list" then
    local any = false
    for name, text in pairs(CPlusTalentsDB.loadouts) do
      local build = CPlusTalents.parseBuild(text)
      printf("  %s |cff9d9d9d(%s)|r", name, build and build.class or "unreadable")
      any = true
    end
    if not any then printf("No loadouts yet. /cplus import to add one.") end
    return
  end

  if arg == "help" then
    printf("/cplus - open the window")
    printf("/cplus import - paste a build from the calculator")
    printf("/cplus list - what is saved")
    return
  end

  local frame = buildUI()
  if frame:IsShown() then frame:Hide() else frame:Show() end
end

local loader = CreateFrame("Frame")
loader:RegisterEvent("PLAYER_LOGIN")
loader:SetScript("OnEvent", function()
  CPlusTalentsDB = CPlusTalentsDB or { loadouts = {} }
  CPlusTalentsDB.loadouts = CPlusTalentsDB.loadouts or {}
  printf("loaded. |cffffd100/cplus|r to open, |cffffd100/cplus import|r to paste a build.")
end)
