import Tag from "../../models/Tag";

const ListTagsService = async (companyId: number) => {
  const tags = await Tag.findAll({
    where: { companyId },
    order: [["name", "ASC"]]
  });
  return tags;
};

export default ListTagsService;
