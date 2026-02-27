import Tag from "../../models/Tag";

const ListTagsService = async () => {
  const tags = await Tag.findAll({ order: [["name", "ASC"]] });
  return tags;
};

export default ListTagsService;
