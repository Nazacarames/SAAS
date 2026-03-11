import User from "../../models/User";

interface ListUsersRequest {
    companyId: number;
}

const ListUsersService = async ({ companyId }: ListUsersRequest): Promise<User[]> => {
    const users = await User.findAll({
        where: { companyId },
        attributes: ["id", "name", "email", "profile", "createdAt"],
        order: [["name", "ASC"]]
    });

    return users;
};

export default ListUsersService;
