import Tag from "../../models/Tag";

const UpsertTagsService = async (names: string[]) => {
  const clean = (names || [])
    .map(n => String(n || "").trim())
    .filter(Boolean)
    .slice(0, 30);

  const tags: Tag[] = [];
  for (const name of clean) {
    const [tag] = await Tag.findOrCreate({ where: { name }, defaults: { name } });
    tags.push(tag);
  }
  return tags;
};

export default UpsertTagsService;
