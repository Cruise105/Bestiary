// Condition rules text from the System Reference Document 5.1 (CC BY 4.0)
export const SRD_CONDITIONS = {
 "blinded": [
  "A blinded creature can't see and automatically fails any ability check that requires sight.",
  "Attack rolls against the creature have advantage, and the creature's attack rolls have disadvantage."
 ],
 "charmed": [
  "A charmed creature can't attack the charmer or target the charmer with harmful abilities or magical effects.",
  "The charmer has advantage on any ability check to interact socially with the creature."
 ],
 "deafened": [
  "A deafened creature can't hear and automatically fails any ability check that requires hearing."
 ],
 "frightened": [
  "A frightened creature has disadvantage on ability checks and attack rolls while the source of its fear is within line of sight.",
  "The creature can't willingly move closer to the source of its fear."
 ],
 "grappled": [
  "A grappled creature's speed becomes 0, and it can't benefit from any bonus to its speed.",
  "The condition ends if the grappler is incapacitated (see the condition).",
  "The condition also ends if an effect removes the grappled creature from the reach of the grappler or grappling effect, such as when a creature is hurled away by the thunderwave spell."
 ],
 "incapacitated": [
  "An incapacitated creature can't take actions or reactions."
 ],
 "invisible": [
  "An invisible creature is impossible to see without the aid of magic or a special sense. For the purpose of hiding, the creature is heavily obscured. The creature's location can be detected by any noise it makes or any tracks it leaves.",
  "Attack rolls against the creature have disadvantage, and the creature's attack rolls have advantage."
 ],
 "paralyzed": [
  "A paralyzed creature is incapacitated (see the condition) and can't move or speak.",
  "The creature automatically fails Strength and Dexterity saving throws.",
  "Attack rolls against the creature have advantage.",
  "Any attack that hits the creature is a critical hit if the attacker is within 5 feet of the creature."
 ],
 "petrified": [
  "A petrified creature is transformed, along with any nonmagical object it is wearing or carrying, into a solid inanimate substance (usually stone). Its weight increases by a factor of ten, and it ceases aging.",
  "The creature is incapacitated (see the condition), can't move or speak, and is unaware of its surroundings.",
  "Attack rolls against the creature have advantage.",
  "The creature automatically fails Strength and Dexterity saving throws.",
  "The creature has resistance to all damage.",
  "The creature is immune to poison and disease, although a poison or disease already in its system is suspended, not neutralized."
 ],
 "poisoned": [
  "A poisoned creature has disadvantage on attack rolls and ability checks."
 ],
 "prone": [
  "A prone creature's only movement option is to crawl, unless it stands up and thereby ends the condition.",
  "The creature has disadvantage on attack rolls.",
  "An attack roll against the creature has advantage if the attacker is within 5 feet of the creature. Otherwise, the attack roll has disadvantage."
 ],
 "restrained": [
  "A restrained creature's speed becomes 0, and it can't benefit from any bonus to its speed.",
  "Attack rolls against the creature have advantage, and the creature's attack rolls have disadvantage.",
  "The creature has disadvantage on Dexterity saving throws."
 ],
 "stunned": [
  "A stunned creature is incapacitated (see the condition), can't move, and can speak only falteringly.",
  "The creature automatically fails Strength and Dexterity saving throws.",
  "Attack rolls against the creature have advantage."
 ],
 "unconscious": [
  "An unconscious creature is incapacitated (see the condition), can't move or speak, and is unaware of its surroundings.",
  "The creature drops whatever it's holding and falls prone.",
  "The creature automatically fails Strength and Dexterity saving throws.",
  "Attack rolls against the creature have advantage.",
  "Any attack that hits the creature is a critical hit if the attacker is within 5 feet of the creature."
 ],
 "concentrating": [
  "Ends if the creature is incapacitated, killed, or casts another concentration spell.",
  "Taking damage requires a Constitution saving throw, DC 10 or half the damage taken, whichever is higher. A failure ends the effect."
 ]
};

// The same from the System Reference Document 5.2 (2024 rules, CC BY 4.0)
export const SRD_CONDITIONS_2024 = {
 "blinded": [
  "Can't See. You can't see and automatically fail any ability check that requires sight.",
  "Attacks Affected. Attack rolls against you have Advantage, and your attack rolls have Disadvantage."
 ],
 "charmed": [
  "Can't Harm the Charmer. You can't attack the charmer or target the charmer with damaging abilities or magical effects.",
  "Social Advantage. The charmer has Advantage on ability checks to interact socially with you."
 ],
 "deafened": [
  "Can't Hear. You can't hear and automatically fail any ability check that requires hearing."
 ],
 "exhaustion": [
  "Exhaustion Levels. This condition is cumulative. Each time you receive it, you gain 1 Exhaustion level. You die if your Exhaustion level is 6.",
  "D20 Tests Affected. When you make a D20 Test, the roll is reduced by 2 times your Exhaustion level.",
  "Speed Reduced. Your Speed is reduced by a number of feet equal to 5 times your Exhaustion level.",
  "Removing Exhaustion Levels. Finishing a Long Rest removes 1 of your Exhaustion levels. When your Exhaustion level reaches 0, the condition ends."
 ],
 "frightened": [
  "Ability Checks and Attacks Affected. You have Disadvantage on ability checks and attack rolls while the source of fear is within line of sight.",
  "Can't Approach. You can't willingly move closer to the source of your fear."
 ],
 "grappled": [
  "Speed 0. Your Speed is 0 and can't increase.",
  "Attacks Affected. You have Disadvantage on attack rolls against any target other than the grappler.",
  "Movable. The grappler can drag or carry you when it moves, but every foot of movement costs it 1 extra foot unless you are Tiny or two or more sizes smaller."
 ],
 "incapacitated": [
  "Inactive. You can't take any action, Bonus Action, or Reaction.",
  "No Concentration. Your Concentration is broken.",
  "Speechless. You can't speak.",
  "Surprised. If you're Incapacitated when you roll Initiative, you have Disadvantage on the roll."
 ],
 "invisible": [
  "Surprise. If you're Invisible when you roll Initiative, you have Advantage on the roll.",
  "Concealed. You aren't affected by any effect that requires its target to be seen unless the effect's creator can somehow see you. Any equipment you are wearing or carrying is also concealed.",
  "Attacks Affected. Attack rolls against you have Disadvantage, and your attack rolls have Advantage. If a creature can somehow see you, you don't gain this benefit against that creature."
 ],
 "paralyzed": [
  "Incapacitated. You have the Incapacitated condition.",
  "Speed 0. Your Speed is 0 and can't increase.",
  "Saving Throws Affected. You automatically fail Strength and Dexterity saving throws.",
  "Attacks Affected. Attack rolls against you have Advantage.",
  "Automatic Critical Hits. Any attack roll that hits you is a Critical Hit if the attacker is within 5 feet of you."
 ],
 "petrified": [
  "Turned to Inanimate Substance. You are transformed, along with any nonmagical objects you are wearing and carrying, into a solid inanimate substance (usually stone). Your weight increases by a factor of ten, and you cease aging.",
  "Incapacitated. You have the Incapacitated condition.",
  "Speed 0. Your Speed is 0 and can't increase.",
  "Attacks Affected. Attack rolls against you have Advantage.",
  "Saving Throws Affected. You automatically fail Strength and Dexterity saving throws.",
  "Resist Damage. You have Resistance to all damage.",
  "Poison Immunity. You have Immunity to the Poisoned condition.",
  "Saving Throws Affected. You automatically fail Strength and Dexterity saving throws.",
  "Resist Damage. You have Resistance to all damage.",
  "Poison Immunity. You have Immunity to the Poisoned condition."
 ],
 "poisoned": [
  "Ability Checks and Attacks Affected. You have Disadvantage on attack rolls and ability checks."
 ],
 "prone": [
  "Restricted Movement. Your only movement options are to crawl or to spend an amount of movement equal to half your Speed (round down) to right yourself and thereby end the condition. If your Speed is 0, you can't right yourself.",
  "Attacks Affected. You have Disadvantage on attack rolls. An attack roll against you has Advantage if the attacker is within 5 feet of you. Otherwise, that attack roll has Disadvantage."
 ],
 "restrained": [
  "Speed 0. Your Speed is 0 and can't increase.",
  "Attacks Affected. Attack rolls against you have Advantage, and your attack rolls have Disadvantage.",
  "Saving Throws Affected. You have Disadvantage on Dexterity saving throws."
 ],
 "stunned": [
  "Incapacitated. You have the Incapacitated condition.",
  "Saving Throws Affected. You automatically fail Strength and Dexterity saving throws.",
  "Attacks Affected. Attack rolls against you have Advantage."
 ],
 "unconscious": [
  "Inert. You have the Incapacitated and Prone conditions, and you drop whatever you're holding.",
  "**When this condition ends, you remain Prone.",
  "Speed 0. Your Speed is 0 and can't increase.",
  "Attacks Affected. Attack rolls against you have Advantage.",
  "Saving Throws Affected. You automatically fail Strength and Dexterity saving throws.",
  "Automatic Critical Hits. Any attack roll that hits you is a Critical Hit if the attacker is within 5 feet of you.",
  "Unaware. You're unaware of your surroundings."
 ]
};
