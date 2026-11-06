// GET /skills: the skills this server can run, with the 0G cost of one billed unit and the
// launch wizard's suggested price (4x cost). Prices come live from 0G /v1/models (cached 1 h).
import { Router } from "express";
import { SKILL_IDS } from "@nightshift/shared";
import { UpstreamError } from "../errors.js";
import { suggestedPriceAtomic } from "../pricing.js";
import { getSkill } from "../skills/index.js";
import { modelUnitPricePico } from "../zg/budget.js";

export const skillsRouter = Router();

skillsRouter.get("/skills", async (_req, res) => {
  const items = await Promise.all(
    SKILL_IDS.map(async (id) => {
      const skill = getSkill(id)!;
      let pico: bigint;
      try {
        pico = await modelUnitPricePico(skill.model);
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        throw new UpstreamError(
          "0g",
          `pricing for ${skill.model}: ${error instanceof Error ? error.message : "unavailable"}`,
        );
      }
      const price = suggestedPriceAtomic(pico, skill.meterPerUnit);
      return {
        id,
        model: skill.model,
        unit: skill.unit,
        costUsdMicroPerUnit: price.costUsdMicroPerUnit.toString(),
        suggestedPriceAtomic: price.suggestedAtomic.toString(),
      };
    }),
  );
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({ skills: items });
});
