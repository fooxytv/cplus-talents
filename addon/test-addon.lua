--[[
Exercises the addon's parsing, planning and applying against a stubbed client.

    lua addon/test-addon.lua

The game is not here, so the API the addon calls is faked: a small talent tree,
a class, a pool of unspent points, and a LearnTalent that behaves like the real
one - refusing in combat, past maxRank, and with no points left.

What this covers is the part that decides what to spend and in what order, which
is the part that costs gold when it is wrong. It cannot tell you the addon loads
in a real client; only the game can.
]]--

local pass, fail = 0, 0
local function ok(name, cond, detail)
  if cond then
    pass = pass + 1
    print("PASS  " .. name)
  else
    fail = fail + 1
    print("FAIL  " .. name .. (detail and ("  -> " .. tostring(detail)) or ""))
  end
end

--------------------------------------------------------------- the fake client

-- tier is what the addon orders by, so Bloodthirst deliberately sits deep
local TREE = {
  [1] = {
    { name = "Booming Voice", tier = 1, rank = 0, maxRank = 5 },
    { name = "Cruelty",       tier = 1, rank = 0, maxRank = 5 },
    { name = "Bloodthirst",   tier = 7, rank = 0, maxRank = 1 },
  },
  [2] = {
    { name = "Deflection",    tier = 1, rank = 0, maxRank = 5 },
  },
}

local STATE = { class = "WARRIOR", points = 51, combat = false }

local function resetClient()
  for _, tab in pairs(TREE) do
    for _, t in ipairs(tab) do t.rank = 0 end
  end
  STATE.points, STATE.combat, STATE.class = 51, false, "WARRIOR"
end

local MESSAGES = {}

_G.GetNumTalentTabs = function() return 2 end
_G.GetNumTalents = function(tab) return #TREE[tab] end
_G.GetTalentInfo = function(tab, i)
  local t = TREE[tab] and TREE[tab][i]
  if not t then return nil end
  return t.name, nil, t.tier, nil, t.rank, t.maxRank
end
_G.GetUnspentTalentPoints = function() return STATE.points end
_G.UnitCharacterPoints = nil
_G.UnitClass = function() return "Warrior", STATE.class end
_G.InCombatLockdown = function() return STATE.combat end
_G.LearnTalent = function(tab, i)
  if STATE.combat then return false end
  local t = TREE[tab] and TREE[tab][i]
  if not t or t.rank >= t.maxRank or STATE.points <= 0 then return false end
  t.rank = t.rank + 1
  STATE.points = STATE.points - 1
  return true
end

-- the addon builds its window at load; stub only what that touches
_G.UIParent, _G.UISpecialFrames = {}, {}
_G.CreateFrame = function()
  return setmetatable({}, { __index = function() return function() end end })
end
_G.DEFAULT_CHAT_FRAME = { AddMessage = function(_, m) MESSAGES[#MESSAGES + 1] = m end }
_G.SlashCmdList = {}

assert(loadfile("addon/CPlusTalents/CPlusTalents.lua"))("CPlusTalents")
local A = CPlusTalents
ok("the addon exposes its working parts",
   A and A.parseBuild and A.plan and A.apply and A.readTalents)

local function rankOf(name)
  for _, tab in pairs(TREE) do
    for _, t in ipairs(tab) do if t.name == name then return t.rank end end
  end
end

--------------------------------------------------------------------- parsing

do
  local b = A.parseBuild("cpt1|forever|WARRIOR|Fury test|Booming Voice=5,Cruelty=3")
  ok("a good string parses", b ~= nil)
  ok("it keeps the edition", b and b.edition == "forever")
  ok("it keeps the class", b and b.class == "WARRIOR")
  ok("it keeps the name", b and b.name == "Fury test")
  ok("it reads the ranks", b and b.talents["Booming Voice"] == 5 and b.talents["Cruelty"] == 3)
  ok("it keeps the order it was given",
     b and b.order[1] == "Booming Voice" and b.order[2] == "Cruelty")

  -- names with spaces must survive, since every real one has them
  local sp = A.parseBuild("cpt1|forever|WARRIOR|x|Improved Battle Shout=2")
  ok("a talent name with spaces parses", sp and sp.talents["Improved Battle Shout"] == 2)

  local bad = {
    { nil,                                  "nothing to read" },
    { "",                                   "not a build" },
    { "nope|forever|WARRIOR|x|A=1",         "wrong prefix" },
    { "cpt1|forever|WARRIOR",               "too few fields" },
    { "cpt1|forever|WARRIOR|x|Cruelty",     "rank missing" },
    { "cpt1|forever|WARRIOR|x|Cruelty=two", "rank not a number" },
  }
  for _, case in ipairs(bad) do
    local got, why = A.parseBuild(case[1])
    ok("refused: " .. case[2], got == nil, why)
  end
end

--------------------------------------------------------------------- planning

do
  resetClient()
  local b = A.parseBuild("cpt1|forever|WARRIOR|t|Bloodthirst=1,Booming Voice=5")
  local steps, problems, needed, free = A.plan(b)
  ok("a clean build plans with no problems", #problems == 0, problems[1])
  ok("it counts the points it needs", needed == 6, needed)
  ok("it reports the points you have", free == 51, free)
  ok("lowest tier is spent first",
     steps[1].name == "Booming Voice" and steps[2].name == "Bloodthirst",
     steps[1] and steps[1].name)
  ok("planning spends nothing", rankOf("Booming Voice") == 0 and STATE.points == 51)
end

do
  resetClient()
  local b = A.parseBuild("cpt1|forever|WARRIOR|t|Nonexistent Talent=2")
  local _, problems = A.plan(b)
  ok("an unknown talent is a problem", #problems == 1 and problems[1]:find("Nonexistent"))
end

do
  resetClient()
  STATE.class = "MAGE"
  local b = A.parseBuild("cpt1|forever|WARRIOR|t|Cruelty=1")
  local _, problems = A.plan(b)
  ok("the wrong class is a problem", #problems >= 1 and problems[1]:find("MAGE"))
  resetClient()
end

do
  resetClient()
  local b = A.parseBuild("cpt1|forever|WARRIOR|t|Cruelty=9")
  local _, problems = A.plan(b)
  ok("more ranks than exist is a problem", #problems >= 1 and problems[1]:find("only goes to 5"))
end

do
  resetClient()
  STATE.points = 2
  local b = A.parseBuild("cpt1|forever|WARRIOR|t|Cruelty=5")
  local _, problems, needed = A.plan(b)
  ok("not enough points is a problem",
     #problems >= 1 and problems[#problems]:find("needs 5 points, you have 2"), problems[#problems])
  resetClient()
end

do
  resetClient()
  TREE[1][2].rank = 4                       -- already 4 in Cruelty
  local b = A.parseBuild("cpt1|forever|WARRIOR|t|Cruelty=5")
  local _, problems, needed = A.plan(b)
  ok("it only tops up what is missing", needed == 1 and #problems == 0, needed)
  resetClient()
end

do
  resetClient()
  TREE[1][2].rank = 5
  local b = A.parseBuild("cpt1|forever|WARRIOR|t|Cruelty=2")
  local _, problems = A.plan(b)
  ok("having more than the build wants is a problem, not a silent unlearn",
     #problems == 1 and problems[1]:find("already at 5"))
  resetClient()
end

--------------------------------------------------------------------- applying

do
  resetClient()
  A.apply(A.parseBuild("cpt1|forever|WARRIOR|t|Booming Voice=5,Deflection=2"))
  ok("apply spends the ranks asked for",
     rankOf("Booming Voice") == 5 and rankOf("Deflection") == 2)
  ok("and takes them from the pool", STATE.points == 51 - 7, STATE.points)
  ok("and says what it did", MESSAGES[#MESSAGES]:find("7 point"), MESSAGES[#MESSAGES])
end

do
  resetClient()
  MESSAGES = {}
  A.apply(A.parseBuild("cpt1|forever|WARRIOR|t|Nonexistent=1,Cruelty=3"))
  ok("a build with any problem spends nothing at all",
     rankOf("Cruelty") == 0 and STATE.points == 51)
  ok("and says so", MESSAGES[1]:find("nothing spent"), MESSAGES[1])
end

do
  resetClient()
  MESSAGES = {}
  STATE.combat = true
  A.apply(A.parseBuild("cpt1|forever|WARRIOR|t|Cruelty=3"))
  ok("nothing is spent in combat", rankOf("Cruelty") == 0 and STATE.points == 51)
  ok("and it says why", MESSAGES[1]:find("combat"), MESSAGES[1])
  resetClient()
end

do
  resetClient()
  MESSAGES = {}
  A.apply(A.parseBuild("cpt1|forever|WARRIOR|t|Cruelty=2"))
  A.apply(A.parseBuild("cpt1|forever|WARRIOR|t|Cruelty=2"))
  ok("applying twice does not spend twice", rankOf("Cruelty") == 2 and STATE.points == 49)
  ok("and it says it already matches", MESSAGES[#MESSAGES]:find("Already matches"))
end

do
  -- if the client starts refusing mid-way, stop rather than loop
  resetClient()
  MESSAGES = {}
  local real = LearnTalent
  local calls = 0
  _G.LearnTalent = function(tab, i)
    calls = calls + 1
    if calls > 2 then return false end
    return real(tab, i)
  end
  A.apply(A.parseBuild("cpt1|forever|WARRIOR|t|Booming Voice=5"))
  ok("a refusal mid-apply stops instead of spinning", rankOf("Booming Voice") == 2, rankOf("Booming Voice"))
  ok("and reports where it got to", MESSAGES[#MESSAGES]:find("stopped after 2"), MESSAGES[#MESSAGES])
  _G.LearnTalent = real
end

print()
print(pass .. " passed, " .. fail .. " failed")
os.exit(fail == 0 and 0 or 1)
