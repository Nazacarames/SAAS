import User from "../../models/User";
import AppError from "../../errors/AppError";

interface CreateUserRequest {
    name: string;
    email: string;
    password: string;
    profile?: string;
    companyId: number;
}

const CreateUserService = async (data: CreateUserRequest): Promise<User> => {
    const { name, email, password, profile = "user", companyId } = data;

    const existingUser = await User.findOne({ where: { email } });

    if (existingUser) {
        throw new AppError("Ya existe un usuario con este email", 400);
    }

    const user = await User.create({
        name,
        email,
        passwordHash: password,
        profile,
        companyId
    });

    return user;
};

export default CreateUserService;
