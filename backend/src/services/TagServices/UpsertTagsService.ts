import Tag from "../../models/Tag";

const UpsertTagsService = async (names: string[], companyId: number) => {
  const clean = (names || [])
    .map(n => String(n || "").trim())
    .filter(Boolean)
    .slice(0, 30);

  const tags: Tag[] = [];
  for (const name of clean) {
    const [tag] = await Tag.findOrCreate({
      where: { name, companyId },
      defaults: { name, companyId } as any
    });
    tags.push(tag);
  }
  return tags;
};

export default UpsertTagsService;
